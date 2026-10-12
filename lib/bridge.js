import { randomUUID } from 'node:crypto';
import { ChannelServer, Emitter, createAcknowledgedWebRemoteControlRelayProtocol,
  encodeTopicWireFrames, helloMessageSchema, parseCommandEnvelope, commandAckSchema, appSettingsSchema, v4AttachmentReadParamsSchema } from './zcode-wire.js';
import { Conversation, remoteMode } from './projection.js';
import { titleOf } from './dsh.js';
import { CURRENT_SELECTION, currentModelView, catalogModelView, toRemoteSelection, resolveSelection } from './model-view.js';
import { ImageUploads, IMAGE_MAX_BYTES } from './images.js';

const unsupported = () => { const e = new Error('Dsh ntr Zcode: this operation is not supported in the text-only preview'); e.stack = ''; throw e; };
const time = value => typeof value === 'number' ? value : Date.parse(value) || Date.now();

export async function directory(backend) {
  const workspaces = await backend.workspaces();
  const tasks = [];
  for (const w of workspaces) for (const s of await backend.sessions(w.path)) tasks.push({
    taskId: s.sessionId, title: titleOf(s), workspacePath: w.path, workspaceLabel: w.title || w.path,
    workspaceKind: 'local', createdAt: time(s.updatedAt), updatedAt: time(s.updatedAt),
    displayStatus: s.running ? 'running' : 'idle', hasBackgroundWork: false,
  });
  return { workspaces: workspaces.map(w => ({ workspacePath: w.path, label: w.title || w.path, kind: 'local', connectionState: 'connected' })), tasks };
}

export class Bridge {
  constructor({ backend, path, identity, send, receipts = new Map(), uploads, audit = () => {}, onFault = () => {} }) {
    Object.assign(this, { backend, path, receipts, audit, onFault });
    this.epoch = randomUUID();
    this.subs = new Map();
    this.events = new Map();
    this.uploads = uploads ?? new ImageUploads();
    this.ownsUploads = !uploads;
    this.adapter = createAcknowledgedWebRemoteControlRelayProtocol({ ...identity, sendFrame: send });
    this.server = new ChannelServer(this.adapter.protocol, 'dsh-ntr-zcode', 1000, true);
    const channels = ['zcode-agent', 'zcode-task', 'zcode-session', 'window-controller', 'setting', 'system',
      'credential', 'model-selection', 'provider-settings', 'client-config', 'client-scenes', 'broadcast',
      'file', 'git', 'memory', 'skills', 'commands', 'plugins', 'plugin-management', 'hooks', 'bots',
      'usage-stats', 'off-peak-task', 'coding-plan-subscription', 'cua-permission', 'subagents', 'onboarding-record', 'settings-sync', 'oauth'];
    for (const channel of channels) this.server.registerChannel(channel, {
      call: async (_ctx, method, args) => {
        audit(`${channel}.${method}`, args);
        if (this.closed) throw new Error('Pairing stopped');
        return this.call(channel, method, args);
      },
      listen: (_ctx, method, args) => {
        audit(`${channel}.${method} [event]`);
        const key = `${channel}.${method}`;
        if (this.closed || (!this.events.has(key) && this.events.size >= 128)) throw new Error('Event subscription limit exceeded');
        if (!this.events.has(key)) this.events.set(key, new Emitter());
        return this.events.get(key).event;
      },
    });
  }
  ready() { this.server.ready(); }
  accept(payload) { this.adapter.acceptPayload(payload); }
  fail(error) {
    if (this.closed) return;
    this.audit(`subscription failed: ${error?.name || 'Error'}`);
    this.dispose();
    this.onFault();
  }
  emit(sub, snapshot, deliveryKind = 'online') {
    if (this.closed || !this.subs.has(sub.id)) return;
    const frame = { topic: sub.topic, subscriptionId: sub.id, fromSeq: 0, toSeq: snapshot.seq ?? ++sub.seq,
      sentAt: Date.now(), payload: { kind: 'snapshot', snapshot } };
    const wires = encodeTopicWireFrames(frame, { deliveryKind, topic: sub.topic, subscriptionId: sub.id,
      logicalFrameId: randomUUID(), logicalFrameOrdinal: ++sub.ordinal,
      measurePhysicalFrameBytes: value => Buffer.byteLength(JSON.stringify(value)) * 2 + 4096 });
    for (const wire of wires) this.events.get(`zcode-agent.${sub.event}`)?.fire(wire);
  }
  async subscribe(kind, params) {
    await this.backend.workspace(this.path);
    if (this.subs.size >= 12) throw new Error('Subscription limit exceeded');
    const id = randomUUID();
    const sub = { id, seq: 0, ordinal: 0, controller: new AbortController(),
      topic: `${kind}/${params.sessionId ?? this.path}`, event: kind === 'conversation' ? 'onDynamicConversationFrame'
        : kind === 'sessions-index' ? 'onDynamicSessionsIndexFrame' : 'onDynamicWorkspaceConfigFrame' };
    if (kind === 'conversation') sub.conversation = new Conversation(await this.backend.session(this.path, params.sessionId), this.epoch, await this.backend.models?.());
    if (this.closed) throw new Error('Pairing stopped');
    this.subs.set(id, sub);
    // The official wire contract requires the ACK before the initial notification.
    sub.timer = setTimeout(async () => {
      try {
        if (kind === 'conversation') {
          let initial = true;
          for await (const frame of this.backend.follow(this.path, params.sessionId, sub.controller.signal)) {
            if (sub.controller.signal.aborted) break;
            if (!sub.conversation.accept(frame)) continue;
            if (initial) this.emit(sub, sub.conversation.snapshot(), 'initial');
            else if (!sub.flush) sub.flush = setTimeout(() => {
              sub.flush = null;
              try { this.emit(sub, sub.conversation.snapshot()); } catch (error) { this.fail(error); }
            }, 100);
            initial = false;
          }
        } else {
          const snapshot = kind === 'workspace-config'
            ? { protocolVersion: 1, workspaceId: this.path, logEpoch: this.epoch, config: { configOptions: [], slashCommands: [] } }
            : { protocolVersion: 1, workspaceId: this.path, logEpoch: this.epoch,
              sessions: (await this.backend.sessions(this.path)).map(s => ({ sessionId: s.sessionId, workspaceId: this.path,
                title: titleOf(s), phase: s.running ? 'running' : 'completedSuccess', sessionEnded: !s.running,
                hasBackgroundWork: false, createdAt: time(s.updatedAt), lastActivityAt: time(s.updatedAt) })) };
          sub.snapshot = snapshot;
          this.emit(sub, snapshot, 'initial');
        }
      } catch (error) {
        if (!sub.controller.signal.aborted) this.fail(error);
      }
    }, 0);
    return { ack: { subscriptionId: id, mode: 'snapshot', logEpoch: this.epoch } };
  }
  async command(raw) {
    const parsed = parseCommandEnvelope(raw);
    if (!parsed.ok) throw new Error('Invalid remote command');
    const c = parsed.envelope;
    if (c.type === 'createSession') {
      if (c.sessionId !== null || c.payload.workspaceId !== this.path) throw new Error('Workspace mismatch');
      await this.backend.workspace(this.path);
    } else await this.backend.session(this.path, c.sessionId);
    const key = JSON.stringify([this.path, c.sessionId, c.commandId]);
    const fingerprint = JSON.stringify([c.type, c.payload]);
    if (this.receipts.has(key)) {
      const previous = this.receipts.get(key);
      if (previous.fingerprint !== fingerprint) throw new Error('Command ID reused with different content');
      return previous.result;
    }
    if (this.receipts.size >= 2000) throw new Error('Command limit reached; restart remote pairing');
    const result = (async () => {
      const ack = { commandId: c.commandId, revisionAtDecision: 0 };
      const reject = () => ({ ...ack, status: 'rejected', reasonCode: 'guard.dshUnsupported', message: 'DSH supports text and existing model/reasoning choices. This input contains an unsupported option.' });
      const validateModel = async selection => {
        if (!selection) return true;
        if (this.backend.models) {
          try { resolveSelection(await this.backend.models(), selection); return true; } catch { return false; }
        }
        return selection.providerId === 'dsh' && selection.modelId === 'current' && selection.options?.reasoningLevel === 'desktop';
      };
      if (c.type === 'createSession') {
        const p = c.payload, config = p.config ?? {}, first = p.firstInput;
        const rawConfig = raw.payload.config ?? {};
        const selection = first?.modelSelection ?? config.modelSelection ?? (config.provider && config.model
          ? { providerId: config.provider, modelId: config.model, options: { reasoningLevel: config.thought } } : undefined);
        if (Object.keys(raw.payload).some(k => !['workspaceId', 'permissionScope', 'firstInput', 'config'].includes(k))
          || Object.keys(rawConfig).some(k => !['mode', 'planEnabled', 'modelSelection', 'provider', 'model', 'thought', 'followupMode'].includes(k))
          || (config.mode && !['build', 'guarded', 'edit', 'yolo'].includes(config.mode)) || config.planEnabled || (config.followupMode && config.followupMode !== 'queue')
          || (config.provider && config.provider !== selection?.providerId) || (config.model && config.model !== selection?.modelId)
          || (config.thought && config.thought !== selection?.options?.reasoningLevel)
          || (first && (Object.keys(raw.payload.firstInput).some(k => !['text', 'attachments', 'modelSelection', 'mode', 'planEnabled'].includes(k))
            || !first.text.trim() || first.text.length > 64000 || first.attachments?.length || first.planEnabled || (first.mode && first.mode !== 'build')))
          || !(await validateModel(selection))) return reject();
        if (this.closed) throw new Error('Pairing stopped');
        if (config.mode && config.mode !== 'build' && !this.backend.checkMode) return reject();
        const id = await this.backend.create(this.path, selection, config.mode);
        if (first) {
          if (this.closed) throw new Error('Pairing stopped');
          await this.backend.prompt(this.path, id, c.commandId, first.text);
        }
        return { ...ack, status: 'accepted', result: { type: 'createSession', sessionId: id,
          ...(first ? { input: { delivery: 'startNow', inputId: c.commandId } } : {}) } };
      }
      if (c.type === 'sendText') {
        const p = c.payload;
        const allowed = new Set(['text', 'attachments', 'requestedDelivery', 'modelSelection', 'mode', 'planEnabled', 'inputOrigin']);
        if (Object.keys(raw.payload).some(key => !allowed.has(key))
          || (!p.text.trim() && !p.attachments?.length) || p.text.length > 64000 || (p.requestedDelivery && p.requestedDelivery !== 'startNow')
          || Object.keys(p.modelSelection?.options ?? {}).some(key => key !== 'reasoningLevel')
          || p.modelExecution || p.planEnabled || (p.mode && !['build', 'guarded', 'edit', 'yolo'].includes(p.mode))) return reject();
        if (!(await validateModel(p.modelSelection))) return { ...ack, status: 'rejected', reasonCode: 'guard.dshModelSelectionInvalid', message: 'Choose an available DSH model and reasoning level.' };
        let images;
        try { images = this.uploads.resolve(this.path, c.sessionId, p.attachments); }
        catch { return { ...ack, status: 'rejected', reasonCode: 'guard.dshImageUploadInvalid', message: 'Attach the image again; only images uploaded for this session can be sent.' }; }
        const summary = await this.backend.session(this.path, c.sessionId);
        if (summary.running) return { ...ack, status: 'rejected', reasonCode: 'guard.dshWaitForTurn' };
        if (this.closed) throw new Error('Pairing stopped');
        if (p.mode && p.mode !== 'build' && !this.backend.checkMode) return reject();
        if (this.backend.checkMode) await this.backend.checkMode(this.path, c.sessionId, p.mode);
        if (this.closed) throw new Error('Pairing stopped');
        if (p.modelSelection && this.backend.selectModel) await this.backend.selectModel(this.path, c.sessionId, p.modelSelection);
        if (this.closed) throw new Error('Pairing stopped');
        await this.backend.prompt(this.path, c.sessionId, c.commandId, p.text, images);
        this.uploads.release(this.path, c.sessionId, p.attachments);
        return { ...ack, status: 'accepted', result: { type: 'inputAccepted', delivery: 'startNow', inputId: c.commandId } };
      }
      if (c.type === 'switchModelConfig') {
        const conversation = [...this.subs.values()].find(s => s.conversation?.summary.sessionId === c.sessionId)?.conversation;
        if (!conversation || c.baseLogEpoch !== this.epoch || c.baseRevision !== conversation.seq) return { ...ack, revisionAtDecision: conversation?.seq ?? 0, status: 'stale', reasonCode: 'guard.dshStaleConfig' };
        const selection = { providerId: c.payload.provider, modelId: c.payload.model, options: { reasoningLevel: c.payload.thought } };
        if (!(await validateModel(selection))) return reject();
        if (this.closed) throw new Error('Pairing stopped');
        conversation.selection = await this.backend.selectModel(this.path, c.sessionId, selection);
        conversation.seq++;
        for (const sub of this.subs.values()) if (sub.conversation?.summary.sessionId === c.sessionId) {
          sub.conversation.selection = conversation.selection;
          this.emit(sub, sub.conversation.snapshot());
        }
        return { ...ack, status: 'accepted', revisionAtDecision: conversation.seq };
      }
      if (c.type === 'renameSession') {
        if (this.closed || !c.payload.title.trim() || c.payload.title.length > 200) return reject();
        await this.backend.rename(this.path, c.sessionId, c.payload.title.trim());
        return { ...ack, status: 'accepted' };
      }
      if (c.type === 'setMode' && this.backend.checkMode) {
        if (this.closed) throw new Error('Pairing stopped');
        await this.backend.checkMode(this.path, c.sessionId, c.payload.mode);
        return { ...ack, status: 'accepted' };
      }
      if (c.type === 'stop') {
        if (this.closed) throw new Error('Pairing stopped');
        await this.backend.cancel(this.path, c.sessionId);
        return { ...ack, status: 'accepted' };
      }
      return { ...ack, status: 'rejected', reasonCode: 'guard.dshUnsupported', message: 'This action is not supported by Dsh ntr Zcode' };
    })().catch(error => ({ commandId: c.commandId, revisionAtDecision: 0, status: 'failed',
      reasonCode: error.reasonCode === 'guard.dshPermissionModeMismatch' ? error.reasonCode : 'fault.dshRequestFailed',
      message: error.reasonCode === 'guard.dshPermissionModeMismatch' ? error.message : 'Check DSH desktop before retrying' }));
    this.receipts.set(key, { fingerprint, result });
    return commandAckSchema.parse(await result);
  }
  async call(channel, method, args) {
    const p = Array.isArray(args) ? args[0] ?? {} : args ?? {};
    if (p.workspacePath && p.workspacePath !== this.path) throw new Error('Workspace mismatch');
    if (channel === 'setting' && method === 'get') return appSettingsSchema.parse({});
    if (channel === 'model-selection' && method === 'getView') return this.backend.models ? catalogModelView(await this.backend.models(), p) : currentModelView();
    if (channel === 'provider-settings' && ['getView', 'refresh'].includes(method)) return { revision: 1, providers: [], providerTemplates: [], providerOrder: [] };
    if (channel === 'settings-sync' && method === 'getFirstRunPromptState') return { handled: true };
    if (channel === 'zcode-session' && method === 'readWorkspacePresentation') return { workspace: { workspacePath: this.path, workspaceKey: this.path }, mode: 'build', slashCommands: [] };
    if (channel === 'zcode-session' && method === 'readSession') {
      const s = await this.backend.session(this.path, p.sessionId);
      const catalog = await this.backend.models?.();
      const selection = toRemoteSelection(s.projections?.values?.modelSelection?.next ?? catalog?.default, catalog);
      const mode = remoteMode(s);
      return { protocol: { name: 'ZCode Protocol', version: 1 },
        session: { sessionId: s.sessionId, workspace: { workspacePath: this.path, workspaceKey: this.path },
          sessionKind: 'interactive', title: titleOf(s), titleSource: 'custom', mode, status: s.running ? 'running' : 'idle',
          model: selection, createdAt: time(s.updatedAt), updatedAt: time(s.updatedAt) },
        settings: { model: { current: selection, available: [] }, thoughtLevel: { enabled: false, current: selection.options.reasoningLevel, available: [] }, mode: { current: mode } },
        projection: { sessionId: s.sessionId, status: s.running ? 'running' : 'idle', mode: 'build', turnCount: 0, totalTokenCount: 0,
          contextUsed: 0, contextWindow: 0, pendingPermissions: [], activeToolCalls: [], backgroundJobs: [] },
        runtime: { eventSeq: 0, stateRevision: 0, pendingRequestIds: [] }, messages: [], slashCommands: [],
      };
    }
    if (channel === 'zcode-task') {
      if (method === 'getWorkspaceProviderConfigFile') return { provider: 'glm', path: '', exists: false };
      if (method === 'getTaskMeta') {
        const s = await this.backend.session(this.path, p.taskId);
        return { taskId: s.sessionId, traceId: s.sessionId, sessionId: s.sessionId, title: titleOf(s), workspacePath: this.path,
          createdAt: time(s.updatedAt), updatedAt: time(s.updatedAt), mode: 'build' };
      }
    }
    if (channel === 'zcode-agent') {
      if (['attachmentBeginV4', 'attachmentChunkV4', 'attachmentCommitV4', 'attachmentAbortV4'].includes(method)) {
        await this.backend.session(this.path, p.sessionId);
        if (this.closed) throw new Error('Pairing stopped');
        const { workspacePath, workspaceIdentity, ...input } = p;
        return this.uploads.handle(method, this.path, { connectionId: this.epoch, ...input });
      }
      if (['attachmentReadV4', 'conversationAttachmentReadV4'].includes(method)) {
        const { workspacePath, workspaceIdentity, connectionId, ...input } = p;
        const read = v4AttachmentReadParamsSchema.parse(input);
        if (!read.ref.startsWith('dsh-image:') || read.ref.length > 256) throw new Error('Unknown image reference');
        const result = await this.backend.image(this.path, read.sessionId, read.ref.slice('dsh-image:'.length));
        if (this.closed) throw new Error('Pairing stopped');
        const bytes = Buffer.from(result.data, 'base64');
        if (bytes.length > IMAGE_MAX_BYTES || read.offset > bytes.length) throw new Error('Image read limit exceeded');
        const end = Math.min(read.offset + read.limit, bytes.length);
        return { dataBase64: bytes.subarray(read.offset, end).toString('base64'), mediaType: result.attachment.mediaType,
          totalBytes: bytes.length, nextOffset: end < bytes.length ? end : null };
      }
      if (method === 'helloConversationV4') return helloMessageSchema.parse({ kind: 'hello', protocolVersion: 3,
        connectionId: this.epoch, clientMode: 'web-remote-replayable', deliveryProfile: 'replayable', serverTime: Date.now(),
        capabilities: { nativeDialogs: false, localTerminal: false, binaryFrames: false, compression: 'none' }, auth: {} });
      if (method === 'initializeConversationV4') return;
      if (method === 'subscribeConversationV4') return this.subscribe('conversation', p);
      if (method === 'subscribeSessionsIndexV4') return this.subscribe('sessions-index', p);
      if (method === 'subscribeWorkspaceConfigV4') return this.subscribe('workspace-config', p);
      if (['unsubscribeConversationV4', 'unsubscribeSessionsIndexV4', 'unsubscribeWorkspaceConfigV4'].includes(method)) { this.unsubscribe(p.subscriptionId); return; }
      if (['resyncConversationV4', 'resyncSessionsIndexV4', 'resyncWorkspaceConfigV4'].includes(method)) {
        const sub = this.subs.get(p.subscriptionId);
        if (!sub) throw new Error('Unknown subscription');
        setTimeout(() => {
          if (this.closed || !this.subs.has(sub.id)) return;
          try {
            const snapshot = sub.conversation?.snapshot() ?? sub.snapshot;
            if (snapshot) this.emit(sub, snapshot, 'recovery');
          } catch (error) { this.fail(error); }
        }, 0);
        return { ack: { subscriptionId: sub.id, mode: 'snapshot', logEpoch: this.epoch } };
      }
      if (method === 'sendConversationCommandV4') return this.command(p.envelope);
      if (method === 'queryConversationCommandsV4') {
        if (!Array.isArray(p.commands) || p.commands.length > 64) throw new Error('Invalid command query');
        return { results: await Promise.all(p.commands.map(async key => {
          if (key.sessionId) await this.backend.session(this.path, key.sessionId);
          return { key, result: await this.receipts.get(JSON.stringify([this.path, key.sessionId, key.commandId]))?.result ?? 'unknown' };
        })) };
      }
    }
    return unsupported();
  }
  unsubscribe(id) {
    const sub = this.subs.get(id);
    if (!sub) return;
    clearTimeout(sub.timer);
    clearTimeout(sub.flush);
    sub.controller.abort();
    this.subs.delete(id);
  }
  dispose() {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsUploads) this.uploads.clear();
    for (const id of this.subs.keys()) this.unsubscribe(id);
    this.server.dispose();
    this.adapter.dispose();
    for (const event of this.events.values()) event.dispose();
  }
}

export class RemoteHost {
  constructor(backend, send, audit = () => {}, onFault = () => {}) {
    Object.assign(this, { backend, send, audit, onFault });
    this.receipts = new Map();
    this.windowId = randomUUID();
    this.uploads = new ImageUploads();
  }
  async accept(p) {
    if (!p || typeof p.zcode_type !== 'string' || this.closed) return;
    if (p.zcode_type === 'rpc-frame' || p.zcode_type === 'rpc-frame-ack') return this.bridge?.accept(p);
    this.audit(p.zcode_type);
    if (p.zcode_type === 'bootstrap-request' || p.zcode_type === 'workspace-list-request') {
      const list = await directory(this.backend);
      if (this.closed) return;
      const current = this.viewState && list.workspaces.some(w => w.workspacePath === this.viewState.activeWorkspaceKey)
        && (!this.viewState.activeTaskId || list.tasks.some(t => t.taskId === this.viewState.activeTaskId && t.workspacePath === this.viewState.activeWorkspaceKey))
        ? this.viewState : list.workspaces[0] ? { activeWorkspaceKey: list.workspaces[0].workspacePath, updatedAt: Date.now() } : undefined;
      this.send({ zcode_type: p.zcode_type.replace('-request', '-response'), requestId: p.requestId,
        success: true, result: { ...list, windowControlSessionId: this.windowId,
          ...(current ? { initialViewState: current } : {}) } });
    } else if (p.zcode_type === 'mobile-view-state-update') {
      const update = this.viewUpdate = Symbol();
      const view = p.viewState;
      if (!view || typeof view.activeWorkspaceKey !== 'string') return;
      try {
        await this.backend.workspace(view.activeWorkspaceKey);
        if (view.activeTaskId) await this.backend.session(view.activeWorkspaceKey, view.activeTaskId);
        if (!this.closed && this.viewUpdate === update) this.viewState = {
          activeWorkspaceKey: view.activeWorkspaceKey, ...(view.activeTaskId ? { activeTaskId: view.activeTaskId } : {}), updatedAt: Date.now(),
        };
      } catch { /* Invalid or revoked scope must not become a restore target. */ }
    } else if (p.zcode_type === 'workspace-bridge-open') {
      const opening = this.opening = Symbol();
      const identity = { bridgeSessionId: p.bridgeSessionId, bridgeGeneration: p.bridgeGeneration, recoveryId: p.recoveryId };
      try {
        const w = await this.backend.workspace(p.workspaceKey);
        if (p.taskId) await this.backend.session(w.path, p.taskId);
        if (this.closed || this.opening !== opening) return;
        this.bridge?.dispose();
        this.bridge = new Bridge({ backend: this.backend, path: w.path, identity, send: this.send, receipts: this.receipts, uploads: this.uploads, audit: this.audit, onFault: this.onFault });
        this.send({ zcode_type: 'workspace-bridge-ready', requestId: p.requestId, ...identity,
          bridge: { ...identity, kind: 'local', workspaceKey: p.workspaceKey, workspacePath: w.path, initialTaskId: p.taskId } });
        this.bridge.ready();
      } catch {
        if (!this.closed && this.opening === opening) this.send({ zcode_type: 'workspace-bridge-error', requestId: p.requestId, ...identity, reason: 'workspace-closed', error: 'Workspace is not shared' });
      }
    } else if (p.zcode_type === 'platform-request') {
      this.send({ zcode_type: 'platform-response', requestId: p.requestId, method: p.method, success: false, error: 'Native desktop actions are not exposed by DSH' });
    }
  }
  dispose() { this.closed = true; this.bridge?.dispose(); this.uploads.clear(); this.backend.dispose?.(); }
}
