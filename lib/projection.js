import { conversationSnapshotSchema } from './zcode-wire.js';
import { titleOf } from './dsh.js';
import { CURRENT_SELECTION, toRemoteSelection } from './model-view.js';
import { imageAttachments } from './images.js';
export const remoteMode = summary => ({ 'read-only': 'build', 'workspace-write': 'edit', 'danger-full-access': 'yolo' }[summary.projections?.values?.permissions?.currentValue] ?? 'build');

const text = content => (Array.isArray(content) ? content : []).filter(b => b.type === 'text').map(b => b.text).join('\n');
const denied = { allowed: false, reasonCode: 'guard.dshUnsupported' };

export class Conversation {
  constructor(summary, epoch, catalog, capabilities = {}) {
    this.summary = summary;
    this.epoch = epoch;
    this.events = new Map();
    this.seq = 0;
    this.running = summary.running;
    this.stream = null;
    this.catalog = catalog;
    this.selection = summary.projections?.values?.modelSelection?.next ?? catalog?.default;
    this.capabilities = capabilities;
    this.pending = [];
  }
  accept(frame) {
    if (frame.type === 'event' && !['user/message', 'assistant/message', 'turn/start', 'turn/end', 'tool/call', 'tool/result', 'agent/inbox/spliced', 'model/selection', 'session/title', 'permission/preset'].includes(frame.event.type) && !frame.event.surfaceOp) return false;
    if (frame.type === 'snapshot') {
      this.events.clear();
      this.stream = null;
      this.maxSeq = 0;
      this.endReason = null;
      this.running = this.summary.running;
      for (const record of frame.records) if (record.type === 'event') this.event(record.event);
      this.summary.projections = frame.projections;
      this.selection = frame.projections?.values?.modelSelection?.next ?? this.selection;
      this.hasMore = frame.hasMore;
      this.cursor = frame.cursor;
      const attempt = frame.assistantStream?.activeAttempt;
      if (attempt) {
        const parts = new Map(), reasoning = new Map();
        for (const row of attempt.stream) {
          if (row.type === 'text-chunks') parts.set(row.index, (parts.get(row.index) ?? '') + row.texts.join(''));
          if (row.type === 'chunk' && row.chunk?.type === 'text-delta') parts.set(row.chunk.index, (parts.get(row.chunk.index) ?? '') + row.chunk.text);
          if (row.type === 'reasoning-chunks') reasoning.set(row.index, (reasoning.get(row.index) ?? '') + row.texts.join(''));
          if (row.type === 'chunk' && row.chunk?.type === 'reasoning-delta') reasoning.set(row.chunk.index, (reasoning.get(row.chunk.index) ?? '') + row.chunk.text);
        }
        this.stream = { id: attempt.attemptId, text: [...parts.values()].join(''), reasoning: [...reasoning.values()].join(''), seq: attempt.startedAfterSeq + 0.5, time: Date.now() };
      }
    } else if (frame.type === 'event') this.event(frame.event);
    else if (frame.type === 'assistant-stream') {
      const f = frame.frame;
      if (f.type === 'start') this.stream = { text: '', id: f.attemptId, seq: (f.startedAfterSeq ?? this.maxSeq ?? 0) + 0.5, time: Date.now() };
      const matches = this.stream && (!f.attemptId || f.attemptId === this.stream.id);
      if (f.type === 'chunk' && matches && f.chunk?.type === 'text-delta') this.stream.text += f.chunk.text;
      if (f.type === 'chunk' && matches && f.chunk?.type === 'reasoning-delta') this.stream.reasoning = (this.stream.reasoning ?? '') + f.chunk.text;
      if (f.type === 'end' && matches) this.stream = null;
    }
    this.seq++;
    return true;
  }
  event(event) {
    this.maxSeq = Math.max(this.maxSeq ?? 0, event.seq);
    if (event.surfaceOp?.op === 'replace') {
      this.cursor = event.seq;
      for (const seq of this.events.keys()) if (seq >= event.surfaceOp.startSeq && seq <= event.surfaceOp.endSeq) this.events.delete(seq);
    }
    if ((event.surfaceOp && ['user/message', 'assistant/message', 'tool/result'].includes(event.type)) || ['tool/call', 'turn/start', 'turn/end'].includes(event.type)) this.events.set(event.seq, event);
    if (event.type === 'agent/inbox/spliced') {
      const p = this.summary.projections?.values ?? {};
      const inbox = { 'next-turn': [], 'next-step': [], ...p.inbox };
      const s = event.data;
      inbox[s.target] = [...inbox[s.target]];
      inbox[s.target].splice(s.start, s.removedCount ?? 0, ...s.inserted);
      this.summary.projections = { values: { ...p, inbox } };
    }
    if (event.type === 'turn/start') { this.running = true; this.endReason = null; }
    if (event.type === 'turn/end') { this.running = false; this.endReason = event.data.reason; }
    if (event.type === 'assistant/message') this.stream = null;
    if (event.type === 'model/selection') this.selection = event.data;
    if (event.type === 'permission/preset') this.summary.projections = { ...this.summary.projections,
      values: { ...this.summary.projections?.values, permissions: { currentValue: event.data.preset } } };
    if (event.type === 'session/title' && typeof event.data?.title === 'string') {
      this.titleUpdatedAt = event.time;
      this.summary.projections = { ...this.summary.projections, values: { ...this.summary.projections?.values, title: event.data.title } };
    }
  }
  snapshot() {
    const rows = [];
    const tools = new Map();
    const headers = new Map();
    let turn = 'initial';
    for (const e of [...this.events.values()].sort((a, b) => a.seq - b.seq)) {
      if (e.data.turn !== undefined) turn = `turn-${e.data.turn}`;
      const base = { rowId: e.seq, entityId: `dsh:${e.seq}`, turnId: turn, createdAt: e.time, createdAtSeq: e.seq };
      if (e.type === 'turn/start') {
        const header = { ...base, kind: 'turnHeader', origin: 'userInput', state: 'running', startedAt: e.time };
        headers.set(turn, header); rows.push(header);
      } else if (e.type === 'turn/end') {
        const header = headers.get(turn);
        if (header) {
          header.state = e.data.reason.kind === 'completed' ? 'completedSuccess' : e.data.reason.kind === 'error' ? 'failed' : 'completedInterrupted';
          header.endedAt = e.time;
        }
        for (const row of tools.values()) if (row.turnId === turn && row.status === 'running') row.status = 'cancelled';
      } else if (e.type === 'user/message' && e.data.source?.kind === 'user') {
        if (!headers.has(turn)) turn = `input-${e.seq}`;
        rows.push({ ...base, turnId: turn, kind: 'userInput', text: text(e.data.content), origin: 'realUser',
          attachments: imageAttachments(e.data.content),
          ...(e.data.source.rpcId ? { sourceCommandId: e.data.source.rpcId } : {}) });
      } else if (e.type === 'user/message' && e.data.source?.kind === 'goal') {
        const header = headers.get(turn);
        if (header) header.origin = 'goalContinuation';
      } else if (e.type === 'user/message' && e.data.source?.kind === 'compact-checkpoint') {
        rows.push({ ...base, kind: 'timelineMarker', lane: 'assistantWork', marker: { type: 'compact',
          origin: e.data.source.sourceCommandId ? 'manual' : 'auto', status: 'success' } });
      } else if (e.type === 'assistant/message') {
        const reasoning = (e.data.message?.content ?? []).filter(b => b.type === 'reasoning').map(b => b.text ?? '').join('\n');
        if (reasoning) rows.push({ ...base, rowId: e.seq - 0.1, turnId: turn, kind: 'reasoning', text: reasoning, state: 'complete' });
        const body = text(e.data.message?.content);
        if (body) rows.push({ ...base, turnId: turn, kind: 'assistantText', text: body, state: 'complete',
          ...(this.capabilities.fork ? { actions: { canFork: true } } : {}) });
      } else if (e.type === 'tool/call') {
        const pending = this.pending.find(x => x.payload.toolCallId === e.data.callId);
        const inputText = typeof e.data.arguments === 'string' ? e.data.arguments : JSON.stringify(e.data.arguments ?? {}, null, 2);
        let input;
        try { input = JSON.parse(inputText); } catch { input = undefined; }
        const row = { ...base, turnId: turn, kind: 'toolCall', toolCallId: e.data.callId, toolName: e.data.name,
          inputText, input,
          status: pending ? 'pendingApproval' : (headers.get(turn)?.state === 'running' || (!headers.has(turn) && this.running)) ? 'running' : 'cancelled',
          ...(pending ? { approvalInteractionId: pending.interactionId } : {}) };
        tools.set(e.data.callId, row); rows.push(row);
      } else if (e.type === 'tool/result') {
        const message = e.data.message;
        const row = tools.get(message?.callId);
        if (row) {
          row.status = message.isError ? 'error' : 'success';
          row.output = { text: text(message.content).slice(0, 64000) };
          row.endedAt = e.time;
          if (message.isError) row.error = { code: 'fault.dshToolFailed', message: row.output.text || 'DSH tool failed' };
        }
      }
    }
    if (this.stream?.reasoning) rows.push({ rowId: this.stream.seq - 0.1, turnId: turn, createdAt: this.stream.time,
      createdAtSeq: Math.floor(this.stream.seq), kind: 'reasoning', text: this.stream.reasoning, state: 'streaming' });
    if (this.stream?.text) rows.push({ rowId: this.stream.seq, turnId: turn, createdAt: this.stream.time,
      createdAtSeq: Math.floor(this.stream.seq), kind: 'assistantText', text: this.stream.text, state: 'streaming' });
    const failed = this.endReason?.kind === 'error';
    const interrupted = this.endReason && !['completed', 'error'].includes(this.endReason.kind);
    const phase = this.running ? 'running' : failed ? 'error' : interrupted ? 'completedInterrupted' : rows.length ? 'completedSuccess' : 'draft';
    const selection = this.selection ? toRemoteSelection(this.selection, this.catalog) : CURRENT_SELECTION;
    const model = this.catalog?.groups.find(g => g.id === selection.providerId)?.models.find(m => m.id === selection.modelId);
    const thoughtLevels = model?.reasoning?.efforts.length ? model.reasoning.efforts.map(e => e.id) : [selection.options.reasoningLevel];
    const values = this.summary.projections?.values ?? {};
    const usage = values.tokenUsage ?? {};
    const pressure = values.contextPressure ?? {};
    const inbox = values.inbox?.['next-turn'] ?? [];
    const goal = values.goal?.goal;
    return conversationSnapshotSchema.parse({
      protocolVersion: 1, sessionId: this.summary.sessionId, logEpoch: this.epoch, seq: this.seq, revision: this.seq,
      control: { phase,
        sessionEnded: !this.running && rows.length > 0, canStop: !!this.running,
        stopState: this.running ? 'stoppable' : 'idle', stopTargetKind: 'unknown', activeWorks: [],
        lastError: failed ? { code: 'fault.dshTurnFailed', message: 'DSH task failed. Check the desktop for details.', source: 'runtime', recoverable: true, at: Date.now() } : null, apiRetry: null },
      availability: { ...Object.fromEntries(['fork', 'compact', 'setFollowupMode', 'queueEdit', 'sendQueuedNow', 'pauseGoal', 'resumeGoal'].map(k => [k, denied])),
        ...Object.fromEntries(['fork', 'compact', 'setFollowupMode', 'queueEdit', 'sendQueuedNow'].filter(k => this.capabilities[k]).map(k => [k, { allowed: true }])),
        pauseGoal: this.capabilities.goal && goal?.phase === 'active' ? { allowed: true } : denied,
        resumeGoal: this.capabilities.goal && ['paused', 'blocked'].includes(goal?.phase) ? { allowed: true } : denied,
        switchModelConfig: this.catalog && !this.running ? { allowed: true } : denied },
      inputRouting: { mode: !this.running && this.autoDrain === false && inbox.length ? 'enqueue' : this.running ? this.capabilities.queueEdit ? (this.followupMode === 'guide' ? 'guide' : 'enqueue') : 'reject' : 'startNow',
        ...(this.running && !this.capabilities.queueEdit ? { reasonCode: 'guard.dshWaitForTurn' } : {}) },
      meta: { title: titleOf(this.summary), titleSource: 'custom' },
      config: { modelSelection: selection, provider: selection.providerId, model: selection.modelId, thought: selection.options.reasoningLevel, thoughtLevels,
        followupMode: this.followupMode || 'queue', mode: remoteMode(this.summary), planEnabled: !!values.plan?.active },
      usage: { contextWindow: pressure.contextWindow ? { usedTokens: pressure.projectedTokens ?? pressure.pressureTokens ?? 0,
        maxTokens: pressure.contextWindow, autoCompactThresholdTokens: null } : null,
        cumulative: { inputTokens: usage.uncachedInputTokens ?? 0, outputTokens: usage.outputTokens ?? 0,
          cacheReadTokens: usage.cacheReadTokens ?? 0, cacheWriteTokens: usage.cacheWriteTokens ?? 0 } },
      queue: { items: inbox.map((m, i) => ({ sourceCommandId: m.source?.rpcId || m.id, queueItemId: m.id, clientId: 'dsh',
        kind: 'sendText', text: text(m.content), attachments: imageAttachments(m.content),
        delivery: { requested: 'queue', admitted: 'queue' }, order: { admissionSeq: i, queuePosition: i },
        steer: { state: 'notRequested' }, dispatch: { state: 'queued' }, admittedAt: 0 })), autoDrain: this.autoDrain ?? true,
        ...(this.autoDrain === false ? { pauseReason: 'stopped' } : {}) },
      pendingInteractions: this.pending, pendingCommands: [], backgroundWorks: [],
      goal: goal ? { targetId: goal.id, objective: goal.objective,
        status: ({ active: 'active', paused: 'paused', blocked: 'paused', complete: 'verified' })[goal.phase],
        summaryTitle: goal.blockedReason?.message ?? null,
        iteration: Math.max(0, (values.goal.roundsStarted ?? 0) - (goal.phase === 'active' ? 1 : 0)), verifications: [] } : null,
      plan: Array.isArray(values.todos) ? { items: values.todos.map((item, i) => ({ id: `dsh-todo-${i}`, content: item.content,
        status: item.status === 'in_progress' ? 'inProgress' : item.status })), updatedAt: this.maxSeq ?? 0 } : null,
      rows: { window: rows, totalCount: rows.length + (this.hasMore ? 1 : 0), firstRowId: this.hasMore ? 0 : rows[0]?.rowId ?? null },
    });
  }
}
