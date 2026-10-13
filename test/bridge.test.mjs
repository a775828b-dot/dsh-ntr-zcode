import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bridge, RemoteHost, directory } from '../lib/bridge.js';
import { DshBackend } from '../lib/dsh.js';
import { Conversation } from '../lib/projection.js';
import { createControl } from '../lib/index.js';
import { conversationTopicFrameSchema } from '../lib/zcode-wire.js';

const summary = { sessionId: 'session', updatedAt: 1000, running: false, projections: { values: { title: 'Existing DSH session' } } };
const workspace = { workspaceId: 'shared', path: '/shared', title: 'Shared', sessionIds: ['session'] };
function fixture() {
  let prompts = 0;
  const backend = {
    workspaces: async () => [workspace], workspace: async path => { assert.equal(path, '/shared'); return workspace; },
    sessions: async () => [summary], session: async (path, id) => { assert.equal(path, '/shared'); assert.equal(id, 'session'); return summary; },
    prompt: async () => { prompts++; }, cancel: async () => {},
  };
  const bridge = new Bridge({ backend, path: '/shared', identity: { bridgeSessionId: 'bridge', bridgeGeneration: 1, recoveryId: 'recovery' }, send: () => true });
  return { backend, bridge, prompts: () => prompts };
}
const command = (payload = {}, id = 'command') => ({ commandId: id, clientId: 'phone', sessionId: 'session', issuedAt: Date.now(), type: 'sendText', payload: { text: 'hello', ...payload } });

test('original task-menu rename RPC persists a scoped title and returns real task metadata', async () => {
  const f = fixture(); const current = structuredClone(summary); let writes = 0;
  f.backend.session = async (path, id) => { assert.equal(path, '/shared'); assert.equal(id, 'session'); return current; };
  f.backend.rename = async (path, id, title) => { await f.backend.session(path, id); writes++; current.projections.values.title = title; };
  try {
    const meta = await f.bridge.call('zcode-task', 'renameTask', [{ taskId: 'session', workspacePath: '/shared', title: ' New title ' }]);
    assert.equal(meta.title, 'New title'); assert.equal(meta.taskId, 'session'); assert.equal(meta.titleOverridden, true);
    for (const title of ['', ' ', 42, 'x'.repeat(1001)]) await assert.rejects(f.bridge.call('zcode-task', 'renameTask', [{ taskId: 'session', title }]));
    await assert.rejects(f.bridge.call('zcode-task', 'renameTask', [{ taskId: 'private', title: 'Secret' }]));
    await assert.rejects(f.bridge.call('zcode-task', 'renameTask', [{ workspacePath: '/private', taskId: 'session', title: 'Secret' }]));
    assert.equal(writes, 1);
  } finally { f.bridge.dispose(); }
});

test('theme broadcasts stay within the web bridge and cannot write desktop settings', async () => {
  const f = fixture(); const received = [];
  f.bridge.events.set('broadcast.onMessage', { fire: x => received.push(x), dispose() {} });
  try {
    for (const payload of ['dark', 'light', 'zai-dark', 'zai-light', 'system']) await f.bridge.call('broadcast', 'send', [{ channel: 'state:theme', payload }]);
    assert.deepEqual(received.map(m => m.payload), ['dark', 'light', 'zai-dark', 'zai-light', 'system']);
    await assert.rejects(f.bridge.call('broadcast', 'send', [{ channel: 'state:theme', payload: 'unknown' }]));
    await assert.rejects(f.bridge.call('broadcast', 'send', [{ channel: 'settings:update', payload: { permissions: 'yolo' } }]));
    assert.equal(f.prompts(), 0);
  } finally { f.bridge.dispose(); }
});

test('session reads and task metadata expose the same actual DSH permission mode', async () => {
  const f = fixture(); const current = structuredClone(summary);
  f.backend.session = async (path, id) => { assert.equal(path, '/shared'); assert.equal(id, 'session'); return current; };
  try {
    for (const [preset, mode] of [['read-only', 'build'], ['workspace-write', 'edit'], ['danger-full-access', 'yolo']]) {
      current.projections.values.permissions = { currentValue: preset };
      const snapshot = await f.bridge.call('zcode-session', 'readSession', [{ sessionId: 'session' }]);
      const meta = await f.bridge.call('zcode-task', 'getTaskMeta', [{ taskId: 'session' }]);
      assert.equal(snapshot.session.mode, mode);
      assert.equal(snapshot.settings.mode.current, mode);
      assert.equal(snapshot.projection.mode, mode);
      assert.equal(meta.mode, mode);
    }
  } finally { f.bridge.dispose(); }
});

test('shell metadata notification preserves title authority and does not resend unchanged facts', () => {
  const f = fixture(); const received = [];
  const conversation = new Conversation(structuredClone(summary), 'epoch');
  const sub = { conversation };
  try {
    f.bridge.notifyTaskMeta(sub);
    f.bridge.events.set('broadcast.onMessage', { fire: x => received.push(x), dispose() {} });
    f.bridge.notifyTaskMeta(sub);
    f.bridge.notifyTaskMeta(sub);
    assert.equal(received.length, 1);
    conversation.event({ type: 'session/title', seq: 2, time: 2000, data: { title: 'New title' } });
    f.bridge.notifyTaskMeta(sub);
    assert.equal(received[1].payload.task.title, 'New title');
    assert.equal(received[1].payload.task.updatedAt, 2000);
    assert.equal(received[1].payload.task.titleOverridden, true);
    assert.equal(received[1].payload.workspacePath, '/shared');
    assert.equal(received[1].payload.event, 'updated');
    assert.equal(received[1].payload.prompt, undefined);
    f.bridge.dispose();
    conversation.event({ type: 'session/title', seq: 3, time: 3000, data: { title: 'After stop' } });
    f.bridge.notifyTaskMeta(sub);
    assert.equal(received.length, 2);
  } finally { f.bridge.dispose(); }
});

test('deleteSession delegates only to guarded draft cleanup and rejects extra options', async () => {
  const f = fixture(); let calls = 0;
  f.backend.discardDraft = async (path, id) => { assert.equal(path, '/shared'); assert.equal(id, 'session'); calls++; return true; };
  try {
    const raw = { ...command({}, 'cleanup'), type: 'deleteSession', payload: {} };
    assert.equal((await f.bridge.command(raw)).status, 'accepted');
    assert.equal((await f.bridge.command(raw)).status, 'accepted');
    assert.equal(calls, 1);
    assert.equal((await f.bridge.command({ ...raw, commandId: 'bad', payload: { force: true } })).status, 'rejected');
    assert.equal(calls, 1);
    f.backend.discardDraft = async () => false;
    assert.equal((await f.bridge.command({ ...raw, commandId: 'used' })).status, 'rejected');
  } finally { f.bridge.dispose(); }
});

test('directory is mapped from the existing DSH session ID/title', async () => {
  const f = fixture();
  try { const d = await directory(f.backend); assert.equal(d.tasks[0].taskId, 'session'); assert.equal(d.tasks[0].title, 'Existing DSH session'); }
  finally { f.bridge.dispose(); }
});

test('duplicate and concurrent commands submit once', async () => {
  const f = fixture();
  try {
    const results = await Promise.all([f.bridge.command(command()), f.bridge.command(command())]);
    assert(results.every(r => r.status === 'accepted'));
    assert.equal(f.prompts(), 1);
    await assert.rejects(f.bridge.command(command({ text: 'different' })), /reused/);
  } finally { f.bridge.dispose(); }
});
test('rejects other sessions/workspaces and arbitrary RPC methods', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.bridge.command({ ...command(), sessionId: 'private' }));
    await assert.rejects(f.bridge.call('zcode-agent', 'helloConversationV4', [{ workspacePath: '/private' }]), /mismatch/);
    await assert.rejects(f.bridge.call('file', 'readFile', [{ path: 'secret' }]), /not supported/);
    assert.equal(f.prompts(), 0);
  } finally { f.bridge.dispose(); }
});
test('unsupported model changes, plans and queued sends are rejected', async () => {
  const f = fixture();
  try {
    for (const [i, p] of [{ planEnabled: true }, { requestedDelivery: 'queue' }, { modelSelection: { providerId: 'other', modelId: 'other' } }].entries()) {
      assert.equal((await f.bridge.command(command(p, `cmd-${i}`))).status, 'rejected');
    }
    assert.equal(f.prompts(), 0);
  } finally { f.bridge.dispose(); }
});
test('disposed bridge does not submit a pending or new message', async () => {
  const f = fixture(); f.bridge.dispose();
  assert.equal((await f.bridge.command(command())).status, 'failed'); assert.equal(f.prompts(), 0);
});

test('unsupported context is rejected instead of silently discarded', async () => {
  const f = fixture();
  try {
    assert.equal((await f.bridge.command(command({ context_refs: [] }))).status, 'rejected');
    assert.equal((await f.bridge.command(command({ unknownFutureFeature: true }, 'future'))).status, 'rejected');
    assert.equal(f.prompts(), 0);
  } finally { f.bridge.dispose(); }
});

test('disposed host cannot send a delayed directory or reopen a bridge', async () => {
  for (const type of ['bootstrap-request', 'workspace-bridge-open']) {
    const f = fixture(); const sent = [];
    let resume;
    const pending = new Promise(resolve => { resume = resolve; });
    f.backend.workspaces = async () => { await pending; return [workspace]; };
    f.backend.workspace = async () => { await pending; return workspace; };
    const host = new RemoteHost(f.backend, p => sent.push(p));
    try {
      const request = host.accept({ zcode_type: type, workspaceKey: '/shared' });
      host.dispose(); resume(); await request;
      assert.deepEqual(sent, []); assert.equal(host.bridge, undefined);
    } finally { host.dispose(); f.bridge.dispose(); }
  }
});

test('reload restores a validated mobile task but never an unshared path', async () => {
  const f = fixture(); const sent = [];
  const host = new RemoteHost(f.backend, p => sent.push(p));
  try {
    await host.accept({ zcode_type: 'mobile-view-state-update', viewState: { activeWorkspaceKey: '/shared', activeTaskId: 'session' } });
    await host.accept({ zcode_type: 'bootstrap-request', requestId: 'one' });
    assert.equal(sent.at(-1).result.initialViewState.activeTaskId, 'session');
    await host.accept({ zcode_type: 'mobile-view-state-update', viewState: { activeWorkspaceKey: '/private', activeTaskId: 'secret' } });
    await host.accept({ zcode_type: 'bootstrap-request', requestId: 'two' });
    assert.equal(sent.at(-1).result.initialViewState.activeWorkspaceKey, '/shared');
    assert.equal(sent.at(-1).result.initialViewState.activeTaskId, 'session');
  } finally { host.dispose(); f.bridge.dispose(); }
});

test('asynchronous snapshot errors close the bridge without an unhandled exception', async () => {
  const f = fixture(); let failed = 0;
  f.bridge.onFault = () => failed++;
  f.bridge.subs.set('sub', { id: 'sub', controller: new AbortController(), conversation: { snapshot() { throw new Error('bad snapshot'); } } });
  await f.bridge.call('zcode-agent', 'resyncConversationV4', [{ subscriptionId: 'sub' }]);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(failed, 1); assert.equal(f.bridge.closed, true);
});

test('DSH stops forwarding a session removed from its shared workspace', async () => {
  let shared = true;
  const ctx = { workspaceController: { async *follow() { yield { type: 'baseline', value: { items: [{ ...workspace, sessionIds: shared ? ['session'] : [] }] } }; } },
    sessionController: { list: async () => ({ items: [summary] }), async *follow() { yield { type: 'first' }; shared = false; yield { type: 'private' }; } } };
  const backend = new DshBackend(ctx, ['shared']); const frames = [];
  try {
    await assert.rejects(async () => { for await (const f of backend.follow('/shared', 'session', new AbortController().signal)) frames.push(f); }, /no longer shared/);
    assert.deepEqual(frames, [{ type: 'first' }]);
  } finally { backend.dispose(); }
});
test('DSH scope cannot read unselected workspaces or submit after disposal', async () => {
  let wrote = false;
  const ctx = { workspaceController: { async *follow() { yield { type: 'baseline', value: { items: [workspace, { ...workspace, workspaceId: 'private', path: '/private' }] } }; } },
    sessionController: { list: async () => ({ items: [summary] }), prompt: async () => { wrote = true; } } };
  const backend = new DshBackend(ctx, ['shared']);
  assert.equal((await backend.workspaces()).length, 1);
  await assert.rejects(backend.workspace('/private'), /not shared/);
  backend.dispose(); await assert.rejects(backend.prompt('/shared', 'session', 'x', 'x'));
  assert.equal(wrote, false);
});
test('projection filters model-only input and applies DSH surface replacements', () => {
  const c = new Conversation(summary, 'epoch');
  const user = (seq, body, kind = 'user') => ({ type: 'event', event: { seq, time: 1000, type: 'user/message', surfaceOp: 'append', data: { content: [{ type: 'text', text: body }], source: { kind } } } });
  c.accept(user(1, 'old')); c.accept(user(2, 'model only', 'compact-checkpoint'));
  const replacement = user(3, 'new'); replacement.event.surfaceOp = { op: 'replace', startSeq: 1, endSeq: 2 }; c.accept(replacement);
  const snapshot = c.snapshot(); assert.deepEqual(snapshot.rows.window.map(r => r.text), ['new']);
  conversationTopicFrameSchema.parse({ topic: 'conversation/session', subscriptionId: 'sub', fromSeq: 0, toSeq: snapshot.seq, sentAt: 1000, payload: { kind: 'snapshot', snapshot } });
});
test('projection displays live text and clears it after durable settlement', () => {
  const c = new Conversation(summary, 'epoch');
  c.accept({ type: 'assistant-stream', frame: { type: 'start', attemptId: 'a', startedAfterSeq: 2 } });
  c.accept({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a', chunk: { type: 'text-delta', text: 'hello' } } });
  assert.equal(c.snapshot().rows.window[0].state, 'streaming');
  c.accept({ type: 'event', event: { seq: 3, time: 1000, type: 'assistant/message', surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: 'hello' }] } } } });
  assert.equal(c.snapshot().rows.window.length, 1); assert.equal(c.snapshot().rows.window[0].state, 'complete');
  c.accept({ type: 'event', event: { seq: 4, time: 1000, type: 'turn/end', data: { reason: { kind: 'error' } } } });
  assert.equal(c.snapshot().control.phase, 'error');
});

test('projection reflects title changes made on the DSH desktop', () => {
  const c = new Conversation({ ...summary }, 'epoch');
  c.accept({ type: 'event', event: { seq: 1, type: 'session/title', data: { title: 'Renamed on desktop' } } });
  assert.equal(c.snapshot().meta.title, 'Renamed on desktop');
});
test('local start requires consent and registered scope before any relay connection', async () => {
  const control = createControl({ workspaceController: { async *follow() { yield { type: 'baseline', value: { items: [workspace] } }; } } });
  try {
    const request = body => new Request('http://localhost/api/plugins/dsh-ntr-zcode/remote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await control.fetch(request({ action: 'start', workspaces: ['shared'] }))).status, 400);
    assert.equal((await control.fetch(request({ action: 'start', consent: true, workspaces: ['private'] }))).status, 400);
  } finally { control.dispose(); }
});

test('stop revokes a start still waiting for workspace validation', async () => {
  let release, first = true;
  const blocked = new Promise(resolve => { release = resolve; });
  const control = createControl({ workspaceController: { async *follow() {
    if (first) { first = false; await blocked; }
    yield { type: 'baseline', value: { items: [workspace] } };
  } } });
  const request = body => new Request('http://localhost/api/plugins/dsh-ntr-zcode/remote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const start = control.fetch(request({ action: 'start', consent: true, workspaces: ['shared'] }));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal((await control.fetch(request({ action: 'stop' }))).status, 200);
    release();
    assert.equal((await start).status, 409);
  } finally { release(); control.dispose(); }
});
