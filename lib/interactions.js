import { randomUUID } from 'node:crypto';

// Remote owns only explicitly opted-in, currently shared requests. On disconnect
// the waterfall continues to the desktop; no request is automatically approved.
export class Interactions {
  constructor(backend) { this.backend = backend; this.items = new Map(); this.settled = new Map(); }
  list(id) { return [...this.items.values()].filter(x => x.sessionId === id).map(x => x.wire); }
  clear() { for (const x of [...this.items.values()]) x.finish(undefined); }
  async ask(kind, request, next) {
    const sessionId = request.agent?.id;
    if (!sessionId || this.backend.lifetime.signal.aborted) return next();
    const workspaces = await this.backend.workspaces();
    const workspace = workspaces.find(w => w.sessionIds.includes(sessionId));
    if (!workspace || request.signal?.aborted || this.items.size >= 32) return next();
    const id = randomUUID();
    const payload = kind === 'permission' ? {
      kind, toolCallId: request.callId || id, toolName: request.toolName,
      summary: request.displayReason?.zh || request.reason || request.toolName,
      detail: request.reason || '', options: [
        { optionId: 'allow', label: 'Allow once', kind: 'allowOnce' },
        { optionId: 'deny', label: 'Reject', kind: 'deny' },
      ],
    } : {
      kind, prompt: request.questions.map(q => [q.question, q.detail].filter(Boolean).join('\n')).join('\n\n'),
      freeText: true, questions: request.questions.map(q => ({
        question: [q.question, q.detail].filter(Boolean).join('\n'), header: q.header || q.id,
        options: (q.options || []).map(o => ({ value: o.label, ...o })), multiSelect: !!q.multiSelect,
      })),
    };
    let finish, resetTimer;
    const claim = new AbortController();
    const result = new Promise(resolve => {
      let settled = false;
      const abort = () => finish(undefined);
      let timer = setTimeout(abort, 120000);
      resetTimer = ms => { clearTimeout(timer); timer = setTimeout(abort, Math.min(120000, Math.max(1, ms))); };
      finish = value => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        claim.abort();
        request.signal?.removeEventListener('abort', abort);
        this.backend.lifetime.signal.removeEventListener('abort', abort);
        this.items.delete(id);
        this.settled.set(id, { sessionId, path: workspace.path, time: Date.now() });
        for (const [key, value] of this.settled) if (this.settled.size > 256 || Date.now() - value.time > 120000) this.settled.delete(key);
        resolve(value);
      };
      request.signal?.addEventListener('abort', abort, { once: true });
      this.backend.lifetime.signal.addEventListener('abort', abort, { once: true });
    });
    this.items.set(id, { sessionId, path: workspace.path, request, finish, resetTimer,
      wire: { interactionId: id, kind, anchorRowId: null, createdAt: Date.now(), payload } });
    if (kind === 'userInput' && request.wait?.timed && this.backend.ctx?.userQuestions) {
      void (async () => {
        for await (const value of this.backend.ctx.userQuestions.attachWait(request.agent, request.wait.callId, claim.signal)) {
          const item = this.items.get(id);
          if (!item) break;
          const now = Date.now();
          item.wire.autoResolution = { state: 'visibleCountdown', startedAt: now, visibleAt: now, deadlineAt: now + Math.min(120000, value.remainingMs) };
          resetTimer(value.remainingMs);
        }
      })().catch(() => finish(undefined));
    }
    if (this.backend.lifetime.signal.aborted || request.signal?.aborted) finish(undefined);
    const answer = await result;
    return answer === undefined ? next() : answer;
  }
  async resolve(path, sessionId, id, answer) {
    await this.backend.session(path, sessionId);
    this.backend.lifetime.signal.throwIfAborted();
    const item = this.items.get(id);
    const settled = this.settled.get(id);
    if (!item && settled?.path === path && settled.sessionId === sessionId && Date.now() - settled.time <= 120000) return false;
    if (!item || item.path !== path || item.sessionId !== sessionId) throw new Error('Interaction expired');
    this.backend.lifetime.signal.throwIfAborted();
    if (item.request.signal?.aborted) throw new Error('Interaction expired');
    if (item.wire.kind === 'permission') {
      if (!['allow', 'deny'].includes(answer.optionId)) throw new Error('Choose an offered approval option');
      item.finish(answer.optionId === 'allow' ? 'allowed-once' : 'rejected');
    } else {
      if (answer.action && answer.action !== 'accept') { item.finish(undefined); return; }
      const values = answer.content?.answers;
      const questions = item.request.questions;
      if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Complete all questions');
      const answers = questions.map((q, index) => {
        const v = answer.content[`answer_${index}`] ?? values[q.question] ?? values[`answer_${index}`] ?? values[String(index)];
        const list = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
        if (list.some(x => typeof x !== 'string' || x.length > 4096)) throw new Error('Invalid answer');
        const offered = new Set((q.options || []).map(o => o.label));
        const selected = list.filter(x => offered.has(x));
        if (!q.multiSelect && selected.length > 1) throw new Error('Choose one answer');
        const custom = list.filter(x => !offered.has(x)).join('\n');
        return { id: q.id, selected, ...(custom ? { custom } : {}) };
      });
      item.finish({ answers });
    }
    return true;
  }
  async snooze(path, sessionId, id) {
    await this.backend.session(path, sessionId);
    this.backend.lifetime.signal.throwIfAborted();
    const item = this.items.get(id);
    if (!item || item.path !== path || item.sessionId !== sessionId || item.wire.kind !== 'userInput') return;
    if (item.wire.autoResolution && item.wire.autoResolution.state !== 'snoozed') {
      item.wire.autoResolution = { state: 'snoozed', startedAt: item.wire.createdAt, snoozedAt: Date.now() };
      item.resetTimer(120000);
    }
  }
}
