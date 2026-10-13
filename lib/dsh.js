import { Interactions } from './interactions.js';
export const signal = () => AbortSignal.timeout(15000);

export function titleOf(session) {
  const title = session.projections?.values?.title;
  return (typeof title === 'string' ? title : title?.title) || session.sessionId;
}

// Only registered workspaces explicitly selected on the local desktop are exposed.
export class DshBackend {
  constructor(ctx, workspaceIds, allowPermissionChanges = false) {
    this.ctx = ctx;
    this.workspaceIds = workspaceIds === null ? null : new Set(workspaceIds);
    this.lifetime = new AbortController();
    this.allowPermissionChanges = allowPermissionChanges;
    this.interactions = new Interactions(this);
    this.followup = new Map();
    this.drafts = new Map();
    this.allowFiles = !!ctx.fileUploads;
  }
  dispose() { this.lifetime.abort(); this.interactions.clear(); this.drafts.clear(); }
  async workspaces() {
    this.lifetime.signal.throwIfAborted();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const iterator = this.ctx.workspaceController.follow(AbortSignal.any([controller.signal, this.lifetime.signal]))[Symbol.asyncIterator]();
    try {
      const { value } = await iterator.next();
      if (value?.type !== 'baseline') throw new Error('DSH workspace API mismatch');
      this.membership = value.value;
      return value.value.items.filter(w => this.workspaceIds === null || this.workspaceIds.has(w.workspaceId));
    } finally {
      clearTimeout(timer);
      controller.abort();
      await iterator.return?.();
    }
  }
  async workspace(path) {
    const found = (await this.workspaces()).find(w => w.path === path);
    if (!found) throw new Error('Workspace is not shared');
    return found;
  }
  async sessions(path) {
    const workspace = await this.workspace(path);
    const ids = new Set(workspace.sessionIds);
    return (await this.ctx.sessionController.list({}, AbortSignal.any([signal(), this.lifetime.signal]))).items.filter(s => ids.has(s.sessionId))
      .map(s => ({ ...s, archived: this.membership?.archivedSessionIds?.includes(s.sessionId) || false,
        pinned: this.membership?.pinnedSessionIds?.includes(s.sessionId) || false }));
  }
  async session(path, id) {
    const item = (await this.sessions(path)).find(s => s.sessionId === id);
    if (!item) throw new Error('Session is not in the shared workspace');
    this.lifetime.signal.throwIfAborted();
    return item;
  }
  async models() {
    this.lifetime.signal.throwIfAborted();
    const catalog = await this.ctx.sessionController.modelCatalog();
    this.lifetime.signal.throwIfAborted();
    return catalog;
  }
  async create(path, selection, mode) {
    const workspace = await this.workspace(path);
    const resolved = selection ? resolveSelection(await this.models(), selection) : null;
    this.lifetime.signal.throwIfAborted();
    const created = await this.ctx.sessionController.create({ workspaceId: workspace.workspaceId });
    await this.checkMode(path, created.sessionId, mode);
    if (resolved) await this.selectModel(path, created.sessionId, selection);
    this.drafts.set(created.sessionId, path);
    return created.sessionId;
  }
  async discardDraft(path, id) {
    if (this.drafts.get(id) !== path) return false;
    const s = await this.session(path, id);
    if (s.blank !== true || s.running || s.pinned) return false;
    const history = await this.history(path, id);
    if (history.records.some(r => r.type === 'event' && ['user/message', 'assistant/message', 'turn/start', 'tool/call', 'agent/inbox/spliced', 'session/title'].includes(r.event.type))) return false;
    const latest = await this.session(path, id);
    if (this.drafts.get(id) !== path || latest.blank !== true || latest.running || latest.pinned) return false;
    this.lifetime.signal.throwIfAborted();
    // DSH has no public session deletion API; unused remote drafts are recoverable.
    await this.ctx.workspaceController.archiveSession({ sessionId: id });
    this.drafts.delete(id);
    return true;
  }
  async selectModel(path, id, selection) {
    const summary = await this.session(path, id);
    if (summary.running) throw new Error('Wait for the DSH task to finish before changing models');
    const catalog = await this.models();
    const resolved = resolveSelection(catalog, selection);
    const current = summary.projections?.values?.modelSelection?.next ?? catalog.default;
    this.lifetime.signal.throwIfAborted();
    if (current.provider === resolved.provider && current.model === resolved.model && current.reasoningEffort === resolved.reasoningEffort) return current;
    return (await this.ctx.sessionController.selectModel({ sessionId: id, ...resolved })).selected;
  }
  async rename(path, id, title) {
    await this.session(path, id);
    this.drafts.delete(id);
    this.lifetime.signal.throwIfAborted();
    return this.ctx.sessionController.rename({ sessionId: id, title });
  }
  async membershipAction(path, id, action) {
    await this.session(path, id);
    if (!['archiveSession', 'unarchiveSession', 'pinSession', 'unpinSession'].includes(action)) throw new Error('Invalid membership action');
    this.drafts.delete(id);
    this.lifetime.signal.throwIfAborted();
    return this.ctx.workspaceController[action]({ sessionId: id });
  }
  async projections(path, id) {
    await this.session(path, id);
    return this.ctx.sessionController.projections({ sessionId: id }, AbortSignal.any([signal(), this.lifetime.signal]));
  }
  async page(path, id, throughSeq, beforeSeq, maxMessages = 100) {
    await this.session(path, id);
    return this.ctx.sessionController.page({ address: { kind: 'session', sessionId: id }, throughSeq, beforeSeq,
      maxMessages: Math.min(200, maxMessages) }, AbortSignal.any([signal(), this.lifetime.signal]));
  }
  async history(path, id) {
    const controller = new AbortController();
    const iterator = this.follow(path, id, controller.signal)[Symbol.asyncIterator]();
    let opening;
    try { opening = (await iterator.next()).value; }
    finally { controller.abort(); await iterator.return?.(); }
    if (opening?.type !== 'snapshot') throw new Error('Missing session history');
    let page = opening;
    const records = [...opening.records];
    while (page.hasMore) {
      if (records.length > 10000) throw new Error('History limit exceeded');
      const first = page.records.find(r => r.type === 'event')?.event.seq;
      if (!Number.isSafeInteger(first)) throw new Error('Invalid history cursor');
      page = await this.page(path, id, opening.cursor, first, 200);
      records.unshift(...page.records);
    }
    return { ...opening, records, hasMore: false };
  }
  async fork(path, id, atSeq) {
    await this.session(path, id);
    this.lifetime.signal.throwIfAborted();
    return this.ctx.sessionController.fork({ sessionId: id, atSeq });
  }
  async queue(path, id, itemId, action) {
    await this.session(path, id);
    this.lifetime.signal.throwIfAborted();
    return this.ctx.sessionController.updateQueue({ sessionId: id, itemId, action });
  }
  async execute(path, id, command) {
    await this.session(path, id);
    if (!/^(\/compact|\/plan(?: off)?|\/goal (pause|resume)|\/goal [^\r\n]{1,4096})$/.test(command)) throw new Error('Unsupported DSH command');
    if (command.startsWith('/goal ')) this.drafts.delete(id);
    const resolved = await this.ctx.sessionController.resolveAgent(id);
    if (resolved.error) throw resolved.error;
    this.lifetime.signal.throwIfAborted();
    const result = await this.ctx.commands.execute(resolved.agent, command, [], this.lifetime.signal);
    if (result?.result.kind !== 'success') throw new Error('DSH command failed');
  }
  async checkMode(path, id, mode) {
    if (!mode) return;
    const preset = { build: 'read-only', guarded: 'read-only', edit: 'workspace-write', yolo: 'danger-full-access' }[mode];
    const summary = await this.session(path, id);
    if (preset && summary.projections?.values?.permissions?.currentValue === preset) return;
    if (!preset || !this.allowPermissionChanges) {
      const error = new Error('Enable remote permission changes in DSH plugin settings, or use the matching desktop permission mode.');
      error.reasonCode = 'guard.dshPermissionModeMismatch';
      throw error;
    }
    if (summary.running) throw new Error('Wait for the DSH task to finish before changing permissions');
    const resolved = await this.ctx.sessionController.resolveAgent(id);
    if (resolved.error) throw resolved.error;
    this.lifetime.signal.throwIfAborted();
    const result = await this.ctx.commands.execute(resolved.agent, `/permission ${preset}`, [], AbortSignal.any([signal(), this.lifetime.signal]));
    if (result?.result.kind !== 'success') throw new Error('DSH permission command failed');
    const updated = await this.session(path, id);
    if (updated.projections?.values?.permissions?.currentValue !== preset) throw new Error('DSH permission selection did not take effect');
  }
  async image(path, id, attachmentId) {
    await this.session(path, id);
    const result = await this.ctx.sessionController.attachment({ sessionId: id, attachmentId });
    this.lifetime.signal.throwIfAborted();
    return result;
  }
  async file(path, id, attachmentId) {
    await this.session(path, id);
    if (!/^sha256:[a-f0-9]{64}$/.test(attachmentId)) throw new Error('Invalid file reference');
    const combined = AbortSignal.any([signal(), this.lifetime.signal]);
    const stop = new AbortController();
    const iterator = this.ctx.sessionController.follow({ address: { kind: 'session', sessionId: id }, maxMessages: 200 },
      AbortSignal.any([combined, stop.signal]))[Symbol.asyncIterator]();
    let opening;
    try { opening = (await iterator.next()).value; }
    finally { stop.abort(); await iterator.return?.(); }
    if (opening?.type !== 'snapshot') throw new Error('Missing attachment history');
    let page = opening, ref;
    const find = content => (content ?? []).find(b => b.type === 'file' && b.attachment?.attachmentId === attachmentId)?.attachment;
    for (let n = 0; n < 100 && !ref; n++) {
      for (const record of page.records) {
        const e = record.event;
        if (e?.type === 'user/message') ref ||= find(e.data.content);
        if (e?.type === 'agent/inbox/spliced') for (const m of e.data.inserted) ref ||= find(m.content);
      }
      if (ref || !page.hasMore) break;
      const first = page.records.find(r => r.type === 'event')?.event.seq;
      if (!Number.isSafeInteger(first)) break;
      page = await this.ctx.sessionController.page({ address: { kind: 'session', sessionId: id }, throughSeq: opening.cursor, beforeSeq: first, maxMessages: 200 }, combined);
    }
    if (!ref || ref.bytes > 8 * 1024 * 1024) throw new Error('File is not a supported attachment of this session');
    const parts = []; let bytes = 0;
    for await (const chunk of this.ctx.attachments.readFileStream(ref, combined)) {
      bytes += chunk.length;
      if (bytes > ref.bytes) throw new Error('File length mismatch');
      parts.push(chunk);
    }
    if (bytes !== ref.bytes) throw new Error('File length mismatch');
    combined.throwIfAborted();
    return { attachment: { ...ref, mediaType: 'application/octet-stream' }, data: Buffer.concat(parts).toString('base64') };
  }
  async *follow(path, id, abortSignal) {
    await this.session(path, id);
    const combined = AbortSignal.any([abortSignal, this.lifetime.signal]);
    for await (const frame of this.ctx.sessionController.follow({ address: { kind: 'session', sessionId: id },
      maxMessages: 200, assistantStream: true }, combined)) {
      const workspace = await this.workspace(path);
      combined.throwIfAborted();
      if (!workspace.sessionIds.includes(id)) throw new Error('Session is no longer shared');
      yield frame;
    }
  }
  async prompt(path, id, commandId, text, images = [], mode = 'queue') {
    await this.session(path, id);
    this.drafts.delete(id);
    this.lifetime.signal.throwIfAborted();
    const content = [];
    for (const part of images) {
      if (part.type !== 'file-upload') { content.push(part); continue; }
      const resolved = await this.ctx.sessionController.resolveAgent(id);
      if (resolved.error) throw resolved.error;
      const upload = await this.ctx.fileUploads.upload(resolved.agent, { data: part.data, name: part.name }, this.lifetime.signal);
      content.push({ type: 'file', receiptId: upload.receiptId });
    }
    this.lifetime.signal.throwIfAborted();
    return this.ctx.sessionController.prompt({ sessionId: id, requestId: commandId,
      mode, content: [...(text.trim() ? [{ type: 'text', text }] : []), ...content] }, AbortSignal.any([signal(), this.lifetime.signal]));
  }
  async cancel(path, id) {
    const summary = await this.session(path, id);
    if (summary.projections?.values?.goal?.goal?.phase === 'active') await this.execute(path, id, '/goal pause');
    return this.ctx.sessionController.cancel({ sessionId: id }, AbortSignal.any([signal(), this.lifetime.signal]));
  }
}
import { resolveSelection } from './model-view.js';

