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
  }
  dispose() { this.lifetime.abort(); }
  async workspaces() {
    this.lifetime.signal.throwIfAborted();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const iterator = this.ctx.workspaceController.follow(AbortSignal.any([controller.signal, this.lifetime.signal]))[Symbol.asyncIterator]();
    try {
      const { value } = await iterator.next();
      if (value?.type !== 'baseline') throw new Error('DSH workspace API mismatch');
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
    return (await this.ctx.sessionController.list({}, AbortSignal.any([signal(), this.lifetime.signal]))).items.filter(s => ids.has(s.sessionId));
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
    return created.sessionId;
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
    this.lifetime.signal.throwIfAborted();
    return this.ctx.sessionController.rename({ sessionId: id, title });
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
  async prompt(path, id, commandId, text, images = []) {
    await this.session(path, id);
    return this.ctx.sessionController.prompt({ sessionId: id, requestId: commandId,
      mode: 'queue', content: [...(text.trim() ? [{ type: 'text', text }] : []), ...images] }, AbortSignal.any([signal(), this.lifetime.signal]));
  }
  async cancel(path, id) {
    await this.session(path, id);
    return this.ctx.sessionController.cancel({ sessionId: id }, AbortSignal.any([signal(), this.lifetime.signal]));
  }
}
import { resolveSelection } from './model-view.js';

