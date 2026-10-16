import { randomUUID } from 'node:crypto';
import { ChannelServer, Emitter, createAcknowledgedWebRemoteControlRelayProtocol,
  encodeTopicWireFrames, helloMessageSchema, parseCommandEnvelope, commandAckSchema, appSettingsSchema, v4AttachmentReadParamsSchema } from './zcode-wire.js';
import { Conversation, remoteMode } from './projection.js';
import { titleOf } from './dsh.js';
import { CURRENT_SELECTION, currentModelView, catalogModelView, toRemoteSelection, resolveSelection } from './model-view.js';
import { ImageUploads, IMAGE_MAX_BYTES } from './images.js';

const unsupported = () => { const e = new Error('Dsh ntr Zcode: this control is not supported by DSH. Use DSH desktop.'); e.stack = ''; throw e; };
const time = value => typeof value === 'number' ? value : Date.parse(value) || Date.now();

export async function directory(backend) {
  const workspaces = await backend.workspaces();
  const tasks = [];
  for (const w of workspaces) for (const s of await backend.sessions(w.path)) tasks.push({
    taskId: s.sessionId, title: titleOf(s), workspacePath: w.path, workspaceLabel: w.title || w.path,
    workspaceKind: 'local', createdAt: time(s.updatedAt), updatedAt: time(s.updatedAt),
    displayStatus: s.running ? 'running' : 'idle', hasBackgroundWork: false, archived: !!s.archived, pinned: !!s.pinned,
  });
  return { workspaces: workspaces.map(w => ({ workspacePath: w.path, label: w.title || w.path, kind: 'local', connectionState: 'connected' })), tasks };
}

export class Bridge {
  constructor({ backend, path, identity, send, receipts = new Map(), uploads, audit = () => {}, onFault = () => {} }) {
    Object.assign(this, { backend, path, receipts, audit, onFault });
    this.epoch = randomUUID();
    this.subs = new Map();
    this.events = new Map();
    this.uploads = uploads ?? new ImageUploads({ allowFiles: backend.allowFiles });
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
    if (sub.conversation) {
      sub.queueVersions ??= new Map();
      sub.queueVersions.set(snapshot.revision, JSON.stringify(snapshot.queue));
      if (sub.queueVersions.size > 64) sub.queueVersions.delete(sub.queueVersions.keys().next().value);
    }
    if (sub.conversation) this.notifyTaskMeta(sub);
    const frame = { topic: sub.topic, subscriptionId: sub.id, fromSeq: 0, toSeq: snapshot.seq ?? ++sub.seq,
      sentAt: Date.now(), payload: { kind: 'snapshot', snapshot } };
    const wires = encodeTopicWireFrames(frame, { deliveryKind, topic: sub.topic, subscriptionId: sub.id,
      logicalFrameId: randomUUID(), logicalFrameOrdinal: ++sub.ordinal,
      measurePhysicalFrameBytes: value => Buffer.byteLength(JSON.stringify(value)) * 2 + 4096 });
    for (const wire of wires) this.events.get(`zcode-agent.${sub.event}`)?.fire(wire);
  }
  notifyTaskMeta(sub) {
    const s = sub.conversation.summary;
    const title = titleOf(s);
    const event = this.events.get('broadcast.onMessage');
    if (!event || this.closed) return;
    // The original shell caches task metadata separately from v4 conversation rows.
    // Its external-task broadcast accepts metadata without a prompt or bot identity.
    const updatedAt = Math.max(time(s.updatedAt), sub.conversation.titleUpdatedAt ?? 0);
    const fingerprint = JSON.stringify([title, updatedAt]);
    if (sub.lastTitle === fingerprint) return;
    sub.lastTitle = fingerprint;
    event.fire({ channel: 'bots:task', payload: {
      workspacePath: this.path, taskId: s.sessionId, event: sub.conversation.running ? 'streaming' : 'updated', updatedAt,
      task: { taskId: s.sessionId, traceId: s.sessionId, title, titleOverridden: true,
        workspacePath: this.path, createdAt: time(s.updatedAt), updatedAt, mode: remoteMode(s) },
    } });
  }
  async subscribe(kind, params) {
    await this.backend.workspace(this.path);
    if (this.subs.size >= 12) throw new Error('Subscription limit exceeded');
    const id = randomUUID();
    const sub = { id, seq: 0, ordinal: 0, controller: new AbortController(),
      topic: `${kind}/${params.sessionId ?? this.path}`, event: kind === 'conversation' ? 'onDynamicConversationFrame'
        : kind === 'sessions-index' ? 'onDynamicSessionsIndexFrame' : 'onDynamicWorkspaceConfigFrame' };
    if (kind === 'conversation') sub.conversation = new Conversation(await this.backend.session(this.path, params.sessionId), this.epoch, await this.backend.models?.(), {
      fork: !!this.backend.fork, compact: !!this.backend.execute, goal: !!this.backend.execute,
      queueEdit: !!this.backend.queue, sendQueuedNow: !!this.backend.queues, setFollowupMode: !!this.backend.queue,
    });
    if (sub.conversation) sub.conversation.autoDrain = this.backend.queues?.autoDrain(params.sessionId) ?? true;
    if (this.closed) throw new Error('Pairing stopped');
    this.subs.set(id, sub);
    if (kind === 'conversation' && this.backend.projections) {
      const refresh = async () => {
        try {
          const projection = await this.backend.projections(this.path, params.sessionId);
          if (sub.controller.signal.aborted || this.closed) return;
          const pending = this.backend.interactions?.list(params.sessionId) ?? [];
          const mode = this.backend.followup?.get(params.sessionId) || 'queue';
          const autoDrain = this.backend.queues?.autoDrain(params.sessionId) ?? true;
          const fingerprint = JSON.stringify([projection, pending, mode, autoDrain]);
          if (sub.runtimeFingerprint !== fingerprint) {
            sub.runtimeFingerprint = fingerprint;
            if (projection) sub.conversation.summary.projections = projection;
            sub.conversation.pending = pending; sub.conversation.followupMode = mode;
            sub.conversation.autoDrain = autoDrain;
            sub.conversation.seq++;
            if (sub.initialSent) this.emit(sub, sub.conversation.snapshot());
          }
          sub.runtimeTimer = setTimeout(refresh, 750);
        } catch (error) { if (!sub.controller.signal.aborted) this.fail(error); }
      };
      sub.runtimeTimer = setTimeout(refresh, 250);
    }
    // The official wire contract requires the ACK before the initial notification.
    sub.timer = setTimeout(async () => {
      try {
        if (kind === 'conversation') {
          let initial = true;
          for await (const frame of this.backend.follow(this.path, params.sessionId, sub.controller.signal)) {
            if (sub.controller.signal.aborted) break;
            if (!sub.conversation.accept(frame)) continue;
            if (initial) { this.emit(sub, sub.conversation.snapshot(), 'initial'); sub.initialSent = true; }
            else if (!sub.flush) sub.flush = setTimeout(() => {
              sub.flush = null;
              try { this.emit(sub, sub.conversation.snapshot()); } catch (error) { this.fail(error); }
            }, 100);
            initial = false;
          }
        } else {
          const update = async (initial) => {
          const snapshot = kind === 'workspace-config'
            ? { protocolVersion: 1, workspaceId: this.path, logEpoch: this.epoch, config: { configOptions: [], slashCommands: [] } }
            : { protocolVersion: 1, workspaceId: this.path, logEpoch: this.epoch,
              sessions: (await this.backend.sessions(this.path)).map(s => ({ sessionId: s.sessionId, workspaceId: this.path,
                title: titleOf(s), phase: s.running ? 'running' : 'completedSuccess', sessionEnded: !s.running,
                hasBackgroundWork: false, createdAt: time(s.updatedAt), lastActivityAt: time(s.updatedAt) })) };
          sub.snapshot = snapshot;
          if (this.closed || sub.controller.signal.aborted) return;
          const fingerprint = JSON.stringify(snapshot);
          if (fingerprint !== sub.fingerprint) { sub.fingerprint = fingerprint; this.emit(sub, snapshot, initial ? 'initial' : 'online'); }
          if (kind === 'sessions-index') sub.runtimeTimer = setTimeout(() => update(false).catch(error => {
            if (!sub.controller.signal.aborted) this.fail(error);
          }), 2000);
          };
          await update(true);
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
      if (this.closed) throw new Error('Pairing stopped');
      const ack = { commandId: c.commandId, revisionAtDecision: 0 };
      const reject = () => ({ ...ack, status: 'rejected', reasonCode: 'guard.dshUnsupported', message: 'This option has no supported DSH mapping. Use the desktop for this operation.' });
      if (c.type === 'deleteSession' && this.backend.discardDraft) {
        if (Object.keys(raw.payload).length || this.closed) return reject();
        return await this.backend.discardDraft(this.path, c.sessionId)
          ? { ...ack, status: 'accepted' } : reject();
      }
      if (['sendQueuedNow', 'reorderQueueItem', 'setAutoDrain'].includes(c.type)) {
        const sub = [...this.subs.values()].find(s => s.conversation?.summary.sessionId === c.sessionId);
        const conversation = sub?.conversation;
        const sameQueue = conversation && sub.queueVersions?.get(c.baseRevision) === JSON.stringify(conversation.snapshot().queue);
        if (!conversation || (c.baseLogEpoch !== undefined && c.baseLogEpoch !== this.epoch)
          || (c.baseRevision !== conversation.seq && !sameQueue)) return { ...ack,
          revisionAtDecision: conversation?.seq ?? 0, status: 'stale', reasonCode: 'guard.dshStaleConfig' };
      }
      if (['forkAssistant', 'editQueueItem', 'deleteQueueItem', 'setFollowupMode', 'pauseGoal', 'resumeGoal'].includes(c.type)) {
        const conversation = [...this.subs.values()].find(s => s.conversation?.summary.sessionId === c.sessionId)?.conversation;
        if (!conversation || (c.baseLogEpoch !== undefined && c.baseLogEpoch !== this.epoch) || c.baseRevision !== conversation.seq) return { ...ack,
          revisionAtDecision: conversation?.seq ?? 0, status: 'stale', reasonCode: 'guard.dshStaleConfig' };
      }
      const validateModel = async selection => {
        if (!selection) return true;
        if (this.backend.models) {
          try { resolveSelection(await this.backend.models(), selection); return true; } catch { return false; }
        }
        return selection.providerId === 'dsh' && selection.modelId === 'current' && selection.options?.reasoningLevel === 'desktop';
      };
      if (['reorderQueueItem', 'setAutoDrain', 'sendQueuedNow'].includes(c.type) && this.backend.queues) {
        const allowed = { reorderQueueItem: ['queueItemId', 'beforeQueueItemId'], setAutoDrain: ['autoDrain'], sendQueuedNow: ['queueItemId', 'modelSelection'] }[c.type];
        if (Object.keys(raw.payload).some(k => !allowed.includes(k)) || !(await validateModel(c.payload.modelSelection))) return reject();
        if (c.type === 'reorderQueueItem') await this.backend.reorderQueue(this.path, c.sessionId, c.payload.queueItemId, c.payload.beforeQueueItemId);
        if (c.type === 'setAutoDrain') await this.backend.setAutoDrain(this.path, c.sessionId, c.payload.autoDrain);
        if (c.type === 'sendQueuedNow') await this.backend.sendQueuedNow(this.path, c.sessionId, c.payload.queueItemId, c.payload.modelSelection);
        return { ...ack, status: 'accepted' };
      }
      if (c.type === 'createSession') {
        const p = c.payload, config = p.config ?? {}, first = p.firstInput;
        const rawConfig = raw.payload.config ?? {};
        const selection = first?.modelSelection ?? config.modelSelection ?? (config.provider && config.model
          ? { providerId: config.provider, modelId: config.model, options: { reasoningLevel: config.thought } } : undefined);
        if (Object.keys(raw.payload).some(k => !['workspaceId', 'permissionScope', 'firstInput', 'config'].includes(k))
          || Object.keys(rawConfig).some(k => !['mode', 'planEnabled', 'modelSelection', 'provider', 'model', 'thought', 'followupMode'].includes(k))
          || (config.mode && !['build', 'guarded', 'edit', 'yolo'].includes(config.mode)) || (config.planEnabled && !this.backend.execute) || (config.followupMode === 'guide' && !this.backend.followup)
          || (config.provider && config.provider !== selection?.providerId) || (config.model && config.model !== selection?.modelId)
          || (config.thought && config.thought !== selection?.options?.reasoningLevel)
          || (first && (Object.keys(raw.payload.firstInput).some(k => !['text', 'attachments', 'modelSelection', 'mode', 'planEnabled'].includes(k))
            || !first.text.trim() || first.text.length > 64000 || first.attachments?.length || (first.planEnabled && !this.backend.execute) || (first.mode && !['build', 'guarded', 'edit', 'yolo'].includes(first.mode))))
          || !(await validateModel(selection))) return reject();
        if (this.closed) throw new Error('Pairing stopped');
        const mode = first?.mode ?? config.mode;
        if (mode && mode !== 'build' && !this.backend.checkMode) return reject();
        const id = await this.backend.create(this.path, selection, mode);
        if (first?.planEnabled ?? config.planEnabled) await this.backend.execute(this.path, id, '/plan');
        if (config.followupMode && this.backend.followup) this.backend.followup.set(id, config.followupMode);
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
          || (!p.text.trim() && !p.attachments?.length) || p.text.length > 64000 || (p.requestedDelivery && !['startNow', 'queue', 'guide'].includes(p.requestedDelivery))
          || (['queue', 'guide'].includes(p.requestedDelivery) && !this.backend.queue)
          || Object.keys(p.modelSelection?.options ?? {}).some(key => key !== 'reasoningLevel')
          || p.modelExecution || (p.planEnabled && !this.backend.execute) || (p.mode && !['build', 'guarded', 'edit', 'yolo'].includes(p.mode))) return reject();
        if (!(await validateModel(p.modelSelection))) return { ...ack, status: 'rejected', reasonCode: 'guard.dshModelSelectionInvalid', message: 'Choose an available DSH model and reasoning level.' };
        let images;
        try {
          if ((p.attachments?.length ?? 0) > 4) throw new Error('Attachment count limit');
          images = [];
          for (const ref of p.attachments ?? []) {
            const kind = ref.ref.startsWith('dsh-image:') ? 'image' : ref.ref.startsWith('dsh-file:') ? 'file' : null;
            if (!kind) { images.push(...this.uploads.resolve(this.path, c.sessionId, [ref])); continue; }
            if (ref.sourceKind || ref.previewRef) throw new Error('Unsupported attachment context');
            const stored = await this.backend[kind](this.path, c.sessionId, ref.ref.slice(9 + (kind === 'image' ? 1 : 0)));
            if (stored.attachment.bytes > IMAGE_MAX_BYTES) throw new Error('Attachment too large');
            images.push({ type: kind === 'image' ? 'image' : 'file-upload', mediaType: stored.attachment.mediaType,
              name: stored.attachment.name, data: stored.data });
          }
        }
        catch { return { ...ack, status: 'rejected', reasonCode: 'guard.dshImageUploadInvalid', message: 'Attach the image again; only images uploaded for this session can be sent.' }; }
        const summary = await this.backend.session(this.path, c.sessionId);
        const delivery = p.requestedDelivery ?? (summary.running ? this.backend.followup?.get(c.sessionId) || 'queue' : 'startNow');
        if (summary.running && (!this.backend.queue || !['queue', 'guide'].includes(delivery))) return { ...ack, status: 'rejected', reasonCode: 'guard.dshWaitForTurn', message: 'Queue or guide this message while DSH is running.' };
        if (summary.running && p.modelSelection) {
          const current = summary.projections?.values?.modelSelection?.next;
          const desired = resolveSelection(await this.backend.models(), p.modelSelection);
          if (!current || ['provider', 'model', 'reasoningEffort'].some(k => current[k] !== desired[k])) return { ...ack, status: 'rejected', reasonCode: 'guard.dshWaitForTurn', message: 'Finish the current turn before changing the model.' };
        }
        if (this.closed) throw new Error('Pairing stopped');
        if (p.mode && p.mode !== 'build' && !this.backend.checkMode) return reject();
        if (this.backend.checkMode) await this.backend.checkMode(this.path, c.sessionId, p.mode);
        if (this.closed) throw new Error('Pairing stopped');
        if (!summary.running && p.modelSelection && this.backend.selectModel) await this.backend.selectModel(this.path, c.sessionId, p.modelSelection);
        if (typeof p.planEnabled === 'boolean' && this.backend.execute && p.planEnabled !== !!summary.projections?.values?.plan?.active) {
          if (summary.running) return reject();
          await this.backend.execute(this.path, c.sessionId, p.planEnabled ? '/plan' : '/plan off');
        }
        if (this.closed) throw new Error('Pairing stopped');
        await this.backend.prompt(this.path, c.sessionId, c.commandId, p.text, images, summary.running && delivery === 'guide' ? 'steer' : 'queue');
        this.uploads.release(this.path, c.sessionId, p.attachments);
        const held = this.backend.queues?.autoDrain(c.sessionId) === false;
        return { ...ack, status: 'accepted', result: { type: 'inputAccepted', delivery: held ? 'queue' : summary.running ? delivery : 'startNow', inputId: c.commandId } };
      }
      if (c.type === 'resolveInteraction' && this.backend.interactions) {
        const resolved = await this.backend.interactions.resolve(this.path, c.sessionId, c.payload.interactionId, c.payload.answer);
        return resolved === false ? { ...ack, status: 'noop', reasonCode: 'proto.alreadyResolved' } : { ...ack, status: 'accepted' };
      }
      if (c.type === 'snoozeInteractionAutoResolution' && this.backend.interactions) {
        await this.backend.interactions.snooze(this.path, c.sessionId, c.payload.interactionId);
        return { ...ack, status: 'accepted' };
      }
      if (['editQueueItem', 'deleteQueueItem'].includes(c.type) && this.backend.queue) {
        if (c.type === 'editQueueItem' && (!c.payload.newText.trim() || c.payload.newText.length > 64000)) return reject();
        if (c.type === 'editQueueItem') {
          const summary = await this.backend.session(this.path, c.sessionId);
          const item = summary.projections?.values?.inbox?.['next-turn']?.find(m => m.id === c.payload.queueItemId);
          if (item?.content.some(b => b.type !== 'text')) return reject();
        }
        if (c.payload.modelExecution || c.payload.modelSelection) return reject();
        await this.backend.queue(this.path, c.sessionId, c.payload.queueItemId, c.type === 'editQueueItem'
          ? { kind: 'edit', content: [{ type: 'text', text: c.payload.newText }] }
          : { kind: c.type === 'deleteQueueItem' ? 'remove' : 'steer' });
        return { ...ack, status: 'accepted' };
      }
      if (c.type === 'setFollowupMode' && this.backend.followup) {
        this.backend.followup.set(c.sessionId, c.payload.mode);
        return { ...ack, status: 'accepted' };
      }
      if (c.type === 'forkAssistant' && this.backend.fork) {
        const conversation = [...this.subs.values()].find(s => s.conversation?.summary.sessionId === c.sessionId)?.conversation;
        const e = conversation?.events.get(c.payload.target.rowId);
        if (!e || e.type !== 'assistant/message' || c.payload.target.entityId !== `dsh:${e.seq}`) return reject();
        const created = await this.backend.fork(this.path, c.sessionId, e.seq);
        return { ...ack, status: 'accepted', result: { type: 'forkAssistant', sessionId: created.sessionId } };
      }
      if (['compact', 'pauseGoal', 'resumeGoal', 'sendGoalCommand'].includes(c.type) && this.backend.execute) {
        const summary = await this.backend.session(this.path, c.sessionId);
        if (c.type === 'compact' && summary.running) return reject();
        if (c.type === 'sendGoalCommand') {
          const p = c.payload;
          if (Object.keys(raw.payload).some(k => !['text', 'displayText', 'modelSelection', 'mode', 'planEnabled'].includes(k))
            || !p.text.trim() || p.text.length > 4096 || /[\r\n]/.test(p.text) || /^(clear|pause|resume|edit)(\s|$)/i.test(p.text.trim())) return reject();
          if (summary.running || !(await validateModel(p.modelSelection))) return reject();
          await this.backend.checkMode(this.path, c.sessionId, p.mode);
          if (p.modelSelection) await this.backend.selectModel(this.path, c.sessionId, p.modelSelection);
          if (typeof p.planEnabled === 'boolean' && p.planEnabled !== !!summary.projections?.values?.plan?.active) await this.backend.execute(this.path, c.sessionId, p.planEnabled ? '/plan' : '/plan off');
        }
        await this.backend.execute(this.path, c.sessionId, ({ compact: '/compact', pauseGoal: '/goal pause', resumeGoal: '/goal resume' })[c.type] || `/goal ${c.payload.text.trim()}`);
        return { ...ack, status: 'accepted' };
      }
      if (c.type === 'switchModelConfig') {
        const conversation = [...this.subs.values()].find(s => s.conversation?.summary.sessionId === c.sessionId)?.conversation;
        if (!conversation || (c.baseLogEpoch !== undefined && c.baseLogEpoch !== this.epoch) || c.baseRevision !== conversation.seq) return { ...ack, revisionAtDecision: conversation?.seq ?? 0, status: 'stale', reasonCode: 'guard.dshStaleConfig' };
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
      if (c.type === 'switchCollaborationMode' && this.backend.checkMode) {
        const conversation = [...this.subs.values()].find(s => s.conversation?.summary.sessionId === c.sessionId)?.conversation;
        if (!conversation || (c.baseLogEpoch !== undefined && c.baseLogEpoch !== this.epoch) || c.baseRevision !== conversation.seq) return { ...ack, status: 'stale', revisionAtDecision: conversation?.seq ?? 0, reasonCode: 'guard.dshStaleConfig' };
        if (!['build', 'edit', 'yolo', 'guarded'].includes(c.payload.mode)) return reject();
        if (this.closed) throw new Error('Pairing stopped');
        await this.backend.checkMode(this.path, c.sessionId, c.payload.mode);
        conversation.summary = await this.backend.session(this.path, c.sessionId);
        conversation.seq++;
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
    if (this.closed) throw new Error('Pairing stopped');
    if (p.workspacePath && p.workspacePath !== this.path) throw new Error('Workspace mismatch');
    if (channel === 'file' && this.backend.preview) {
      const ids = [...new Set([...this.subs.values()].flatMap(s => s.conversation ? [s.conversation.summary.sessionId] : []))];
      if (['readMediaPreview', 'readTextFile', 'readBinaryPreview', 'readFileRange', 'stat', 'resolvePath'].includes(method)) {
        const result = await this.backend.preview(this.path, ids, method, p);
        if (this.closed) throw new Error('Pairing stopped');
        return result;
      }
      if (method === 'checkFilesExist') {
        if (!Array.isArray(p.paths) || p.paths.length > 32) throw new Error('Invalid file list');
        const results = [];
        for (const path of p.paths) {
          let exists = false;
          try { await this.backend.preview(this.path, ids, 'stat', { path }); exists = true; } catch {}
          results.push({ path, exists });
        }
        if (this.closed) throw new Error('Pairing stopped');
        return results;
      }
    }
    if (channel === 'broadcast' && method === 'send' && p.channel === 'state:theme') {
      if (!['dark', 'light', 'zai-dark', 'zai-light', 'system'].includes(p.payload)) throw new Error('Invalid theme');
      // This is a web presentation preference, never a DSH settings mutation.
      this.events.get('broadcast.onMessage')?.fire({ channel: 'state:theme', payload: p.payload });
      return;
    }
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
        projection: { sessionId: s.sessionId, status: s.running ? 'running' : 'idle', mode, turnCount: 0, totalTokenCount: 0,
          contextUsed: 0, contextWindow: 0, pendingPermissions: [], activeToolCalls: [], backgroundJobs: [] },
        runtime: { eventSeq: 0, stateRevision: 0, pendingRequestIds: [] }, messages: [], slashCommands: [],
      };
    }
    if (channel === 'zcode-task') {
      if (method === 'renameTask' && this.backend.rename) {
        if (typeof p.title !== 'string' || !p.title.trim() || p.title.length > 1000) throw new Error('Invalid task title');
        await this.backend.rename(this.path, p.taskId, p.title.trim());
        return { ...await this.call('zcode-task', 'getTaskMeta', [{ taskId: p.taskId }]), titleOverridden: true };
      }
      if (['setTaskPinned', 'archiveTask', 'unarchiveTask'].includes(method) && this.backend.membershipAction) {
        if (method === 'setTaskPinned' && typeof p.pinned !== 'boolean') throw new Error('Invalid pin');
        await this.backend.membershipAction(this.path, p.taskId, method === 'setTaskPinned' ? (p.pinned ? 'pinSession' : 'unpinSession')
          : method === 'archiveTask' ? 'archiveSession' : 'unarchiveSession');
        return this.call('zcode-task', 'getTaskMeta', [{ taskId: p.taskId }]);
      }
      if (method === 'getWorkspaceProviderConfigFile') return { provider: 'glm', path: '', exists: false };
      if (method === 'getTaskMeta') {
        const s = await this.backend.session(this.path, p.taskId);
        return { taskId: s.sessionId, traceId: s.sessionId, sessionId: s.sessionId, title: titleOf(s), workspacePath: this.path,
          createdAt: time(s.updatedAt), updatedAt: time(s.updatedAt), mode: remoteMode(s) };
      }
    }
    if (channel === 'zcode-agent') {
      if (method === 'conversationPlansV4' && this.backend.history) {
        await this.backend.session(this.path, p.sessionId);
        const active = [...this.subs.values()].find(s => s.conversation?.summary.sessionId === p.sessionId)?.conversation;
        if (!active) throw new Error('Subscribe before loading plans');
        if (active.planDirectory?.through !== active.maxSeq) {
          const full = new Conversation(structuredClone(active.summary), this.epoch, active.catalog);
          full.accept(await this.backend.history(this.path, p.sessionId));
          active.planDirectory = { through: active.maxSeq, plans: full.snapshot().rows.window.filter(r => r.kind === 'toolCall' && r.toolName === 'exit_plan_mode' && ['success', 'error', 'cancelled'].includes(r.status)).reverse() };
        }
        return { plans: active.planDirectory.plans, atSeq: active.seq, atLogEpoch: this.epoch };
      }
      if (method === 'conversationRowsRangeV4' && this.backend.page) {
        if (!Number.isInteger(p.limit) || p.limit < 1 || p.limit > 200 || (p.beforeRowId !== undefined && (!Number.isFinite(p.beforeRowId) || p.beforeRowId < 0))) throw new Error('Invalid history range');
        const active = [...this.subs.values()].find(s => s.conversation?.summary.sessionId === p.sessionId)?.conversation;
        if (!active || !Number.isSafeInteger(active.cursor)) throw new Error('Subscribe before loading history');
        const page = await this.backend.page(this.path, p.sessionId, active.cursor, p.beforeRowId === undefined ? undefined : Math.ceil(p.beforeRowId), p.limit);
        const history = new Conversation(structuredClone(active.summary), this.epoch, active.catalog);
        history.accept({ type: 'snapshot', ...page, projections: active.summary.projections });
        const all = history.snapshot().rows.window.filter(r => p.beforeRowId === undefined || r.rowId < p.beforeRowId);
        return { rows: all.slice(-p.limit), hasMore: page.hasMore || all.length > p.limit, atSeq: active.seq, atRevision: active.seq, atLogEpoch: this.epoch };
      }
      if (['attachmentBeginV4', 'attachmentChunkV4', 'attachmentCommitV4', 'attachmentAbortV4'].includes(method)) {
        await this.backend.session(this.path, p.sessionId);
        if (this.closed) throw new Error('Pairing stopped');
        const { workspacePath, workspaceIdentity, ...input } = p;
        return this.uploads.handle(method, this.path, { connectionId: this.epoch, ...input });
      }
      if (['attachmentReadV4', 'conversationAttachmentReadV4'].includes(method)) {
        const { workspacePath, workspaceIdentity, connectionId, ...input } = p;
        const read = v4AttachmentReadParamsSchema.parse(input);
        const artifact = /^zcode-artifact:\/\/dsh\/image\/(sha256:[a-f0-9]{64})$/.exec(read.ref);
        const kind = artifact || read.ref.startsWith('dsh-image:') ? 'image' : read.ref.startsWith('dsh-file:') ? 'file' : null;
        if (!kind || read.ref.length > 256 || !this.backend[kind]) throw new Error('Unknown attachment reference');
        const result = await this.backend[kind](this.path, read.sessionId, artifact?.[1] ?? read.ref.slice(kind === 'image' ? 10 : 9));
        if (this.closed) throw new Error('Pairing stopped');
        const bytes = Buffer.from(result.data, 'base64');
        if (bytes.length > IMAGE_MAX_BYTES || read.offset > bytes.length) throw new Error('Image read limit exceeded');
        const end = Math.min(read.offset + read.limit, bytes.length);
        return { dataBase64: bytes.subarray(read.offset, end).toString('base64'), mediaType: result.attachment.mediaType,
          totalBytes: bytes.length, nextOffset: end < bytes.length ? end : null };
      }
      if (method === 'helloConversationV4') return helloMessageSchema.parse({ kind: 'hello', protocolVersion: 3,
        connectionId: this.epoch, clientMode: 'web-remote-replayable', deliveryProfile: 'replayable', serverTime: Date.now(),
        capabilities: { nativeDialogs: false, localTerminal: false, binaryFrames: false, compression: 'none', independentPlanState: !!this.backend.execute }, auth: {} });
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
    clearTimeout(sub.runtimeTimer);
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
    this.uploads = new ImageUploads({ allowFiles: backend.allowFiles });
  }
  watchDirectory() {
    if (this.directoryTimer || !this.backend.projections) return;
    const refresh = async () => {
      try {
        const list = await directory(this.backend);
        if (this.closed) return;
        const fingerprint = JSON.stringify(list);
        if (fingerprint !== this.directoryFingerprint) { this.directoryFingerprint = fingerprint;
          this.send({ zcode_type: 'workspace-list-updated', result: { ...list, windowControlSessionId: this.windowId } }); }
        this.directoryTimer = setTimeout(refresh, 2000);
      } catch { if (!this.closed) this.onFault(); }
    };
    this.directoryTimer = setTimeout(refresh, 2000);
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
      this.watchDirectory();
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
  dispose() { this.closed = true; clearTimeout(this.directoryTimer); this.bridge?.dispose(); this.uploads.clear(); this.backend.dispose?.(); }
}
