import { conversationSnapshotSchema } from './zcode-wire.js';
import { titleOf } from './dsh.js';
import { CURRENT_SELECTION, toRemoteSelection } from './model-view.js';
import { imageAttachments } from './images.js';
export const remoteMode = summary => ({ 'read-only': 'build', 'workspace-write': 'edit', 'danger-full-access': 'yolo' }[summary.projections?.values?.permissions?.currentValue] ?? 'build');

const text = content => (Array.isArray(content) ? content : []).filter(b => b.type === 'text').map(b => b.text).join('\n');
const denied = { allowed: false, reasonCode: 'guard.dshUnsupported' };

export class Conversation {
  constructor(summary, epoch, catalog) {
    this.summary = summary;
    this.epoch = epoch;
    this.events = new Map();
    this.seq = 0;
    this.running = summary.running;
    this.stream = null;
    this.catalog = catalog;
    this.selection = summary.projections?.values?.modelSelection?.next ?? catalog?.default;
  }
  accept(frame) {
    if (frame.type === 'event' && !['user/message', 'assistant/message', 'turn/start', 'turn/end', 'model/selection', 'session/title', 'permission/preset'].includes(frame.event.type) && !frame.event.surfaceOp) return false;
    if (frame.type === 'snapshot') {
      this.events.clear();
      for (const record of frame.records) if (record.type === 'event') this.event(record.event);
      this.summary.projections = frame.projections;
      this.selection = frame.projections?.values?.modelSelection?.next ?? this.selection;
      this.hasMore = frame.hasMore;
      this.cursor = frame.cursor;
      const attempt = frame.assistantStream?.activeAttempt;
      if (attempt) {
        const parts = new Map();
        for (const row of attempt.stream) {
          if (row.type === 'text-chunks') parts.set(row.index, (parts.get(row.index) ?? '') + row.texts.join(''));
          if (row.type === 'chunk' && row.chunk?.type === 'text-delta') parts.set(row.chunk.index, (parts.get(row.chunk.index) ?? '') + row.chunk.text);
        }
        this.stream = { id: attempt.attemptId, text: [...parts.values()].join(''), seq: attempt.startedAfterSeq + 0.5, time: Date.now() };
      }
    } else if (frame.type === 'event') this.event(frame.event);
    else if (frame.type === 'assistant-stream') {
      const f = frame.frame;
      if (f.type === 'start') this.stream = { text: '', id: f.attemptId, seq: (f.startedAfterSeq ?? this.maxSeq ?? 0) + 0.5, time: Date.now() };
      if (f.type === 'chunk' && this.stream && f.chunk?.type === 'text-delta') this.stream.text += f.chunk.text;
      if (f.type === 'end') this.stream = null;
    }
    this.seq++;
    return true;
  }
  event(event) {
    this.maxSeq = Math.max(this.maxSeq ?? 0, event.seq);
    if (event.surfaceOp?.op === 'replace') {
      for (const seq of this.events.keys()) if (seq >= event.surfaceOp.startSeq && seq <= event.surfaceOp.endSeq) this.events.delete(seq);
    }
    if (event.surfaceOp && ['user/message', 'assistant/message'].includes(event.type)) this.events.set(event.seq, event);
    if (event.type === 'turn/start') { this.running = true; this.endReason = null; }
    if (event.type === 'turn/end') { this.running = false; this.endReason = event.data.reason; }
    if (event.type === 'assistant/message') this.stream = null;
    if (event.type === 'model/selection') this.selection = event.data;
    if (event.type === 'permission/preset') this.summary.projections = { ...this.summary.projections,
      values: { ...this.summary.projections?.values, permissions: { currentValue: event.data.preset } } };
    if (event.type === 'session/title' && typeof event.data?.title === 'string') {
      this.summary.projections = { ...this.summary.projections, values: { ...this.summary.projections?.values, title: event.data.title } };
    }
  }
  snapshot() {
    const rows = [];
    let turn = 'initial';
    for (const e of [...this.events.values()].sort((a, b) => a.seq - b.seq)) {
      const base = { rowId: e.seq, turnId: turn, createdAt: e.time, createdAtSeq: e.seq };
      if (e.type === 'user/message' && e.data.source?.kind === 'user') {
        turn = `input-${e.seq}`;
        rows.push({ ...base, turnId: turn, kind: 'userInput', text: text(e.data.content), origin: 'realUser',
          attachments: imageAttachments(e.data.content),
          ...(e.data.source.rpcId ? { sourceCommandId: e.data.source.rpcId } : {}) });
      } else if (e.type === 'assistant/message') {
        const body = text(e.data.message?.content);
        if (body) rows.push({ ...base, turnId: turn, kind: 'assistantText', text: body, state: 'complete' });
      }
    }
    if (this.stream?.text) rows.push({ rowId: this.stream.seq, turnId: turn, createdAt: this.stream.time,
      createdAtSeq: Math.floor(this.stream.seq), kind: 'assistantText', text: this.stream.text, state: 'streaming' });
    const failed = this.endReason?.kind === 'error';
    const interrupted = this.endReason && !['completed', 'error'].includes(this.endReason.kind);
    const phase = this.running ? 'running' : failed ? 'error' : interrupted ? 'completedInterrupted' : rows.length ? 'completedSuccess' : 'draft';
    const selection = this.selection ? toRemoteSelection(this.selection, this.catalog) : CURRENT_SELECTION;
    const model = this.catalog?.groups.find(g => g.id === selection.providerId)?.models.find(m => m.id === selection.modelId);
    const thoughtLevels = model?.reasoning?.efforts.length ? model.reasoning.efforts.map(e => e.id) : [selection.options.reasoningLevel];
    return conversationSnapshotSchema.parse({
      protocolVersion: 1, sessionId: this.summary.sessionId, logEpoch: this.epoch, seq: this.seq, revision: this.seq,
      control: { phase,
        sessionEnded: !this.running && rows.length > 0, canStop: !!this.running,
        stopState: this.running ? 'stoppable' : 'idle', stopTargetKind: 'unknown', activeWorks: [],
        lastError: failed ? { code: 'fault.dshTurnFailed', message: 'DSH task failed. Check the desktop for details.', source: 'runtime', recoverable: true, at: Date.now() } : null, apiRetry: null },
      availability: { ...Object.fromEntries(['fork', 'compact', 'setFollowupMode', 'queueEdit', 'sendQueuedNow', 'pauseGoal', 'resumeGoal'].map(k => [k, denied])),
        switchModelConfig: this.catalog && !this.running ? { allowed: true } : denied },
      inputRouting: { mode: this.running ? 'reject' : 'startNow', ...(this.running ? { reasonCode: 'guard.dshWaitForTurn' } : {}) },
      meta: { title: titleOf(this.summary), titleSource: 'custom' },
      config: { modelSelection: selection, provider: selection.providerId, model: selection.modelId, thought: selection.options.reasoningLevel, thoughtLevels, followupMode: 'queue', mode: remoteMode(this.summary) },
      usage: { contextWindow: null, cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      queue: { items: [], autoDrain: true }, pendingInteractions: [], pendingCommands: [], backgroundWorks: [], goal: null, plan: null,
      rows: { window: rows, totalCount: rows.length, firstRowId: rows[0]?.rowId ?? null },
    });
  }
}
