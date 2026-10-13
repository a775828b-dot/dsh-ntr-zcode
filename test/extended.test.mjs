import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { Interactions } from '../lib/interactions.js';
import { Conversation } from '../lib/projection.js';
import { Bridge } from '../lib/bridge.js';
import { DshBackend } from '../lib/dsh.js';
import { ImageUploads } from '../lib/images.js';

const workspace = { workspaceId: 'w', path: '/shared', sessionIds: ['s'] };
const summary = () => ({ sessionId: 's', running: false, projections: { values: {} } });
function fixture() {
  const state = summary(), actions = [];
  const backend = { lifetime: new AbortController(), followup: new Map(),
    workspaces: async () => [workspace], workspace: async p => { assert.equal(p, workspace.path); return workspace; },
    session: async (p, id) => { assert.equal(p, workspace.path); assert.equal(id, 's'); return state; },
    queue: async (...args) => actions.push(args), execute: async (...args) => actions.push(args),
    checkMode: async () => {}, prompt: async (...args) => actions.push(args),
    membershipAction: async (...args) => actions.push(args),
  };
  backend.interactions = new Interactions(backend);
  const bridge = new Bridge({ backend, path: workspace.path,
    identity: { bridgeSessionId: 'b', bridgeGeneration: 1, recoveryId: 'r' }, send: () => true });
  bridge.subs.set('test', { id: 'test', controller: new AbortController(), conversation: new Conversation(state, bridge.epoch) });
  const command = (type, payload, extra = {}) => bridge.command({ commandId: crypto.randomUUID(), clientId: 'phone', sessionId: 's', issuedAt: Date.now(), type, payload, baseRevision: 0, baseLogEpoch: bridge.epoch, ...extra });
  return { backend, bridge, command, state, actions, close: () => { backend.lifetime.abort(); bridge.dispose(); } };
}

test('remote approval is scoped, single-use, and cannot grant always', async () => {
  const f = fixture();
  try {
    const pending = f.backend.interactions.ask('permission', { agent: { id: 's' }, toolName: 'test', callId: 'call' }, () => 'desktop');
    await delay(0);
    const id = f.backend.interactions.list('s')[0].interactionId;
    await assert.rejects(f.backend.interactions.resolve('/other', 's', id, { optionId: 'allow' }));
    await assert.rejects(f.backend.interactions.resolve('/shared', 's', id, { optionId: 'always' }));
    await f.backend.interactions.resolve('/shared', 's', id, { optionId: 'allow' });
    assert.equal(await pending, 'allowed-once');
    assert.equal(await f.backend.interactions.resolve('/shared', 's', id, { optionId: 'allow' }), false);
  } finally { f.close(); }
});
test('disconnect, abort and unshared interaction fall back without approving', async () => {
  for (const mode of ['disconnect', 'abort', 'unshared']) {
    const f = fixture(), abort = new AbortController();
    try {
      const pending = f.backend.interactions.ask('permission', { agent: { id: mode === 'unshared' ? 'private' : 's' }, toolName: 'test', signal: abort.signal }, () => 'desktop');
      await delay(0);
      if (mode === 'disconnect') f.backend.lifetime.abort();
      else if (mode === 'abort') abort.abort();
      assert.equal(await pending, 'desktop');
      assert.equal(f.backend.interactions.items.size, 0);
    } finally { f.close(); }
  }
});
test('structured question answers preserve multi-select and custom text', async () => {
  const f = fixture();
  try {
    const pending = f.backend.interactions.ask('userInput', { agent: { id: 's' }, questions: [
      { id: 'q1', question: 'Pick', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true },
      { id: 'q2', question: 'Notes', detail: 'Full review details' },
    ] }, () => 'desktop');
    await delay(0);
    const [wire] = f.backend.interactions.list('s');
    assert.match(wire.payload.questions[1].question, /Full review details/);
    await f.backend.interactions.resolve('/shared', 's', wire.interactionId, { action: 'accept', content: { answers: {}, answer_0: ['A', 'B', 'Other'], answer_1: 'Hello' } });
    assert.deepEqual(await pending, { answers: [{ id: 'q1', selected: ['A', 'B'], custom: 'Other' }, { id: 'q2', selected: [], custom: 'Hello' }] });
  } finally { f.close(); }
});
test('queue and guide delivery reach the actual host; busy startNow is rejected', async () => {
  const f = fixture(); f.state.running = true;
  try {
    assert.equal((await f.command('sendText', { text: 'later', requestedDelivery: 'queue' })).status, 'accepted');
    assert.equal(f.actions.at(-1).at(-1), 'queue');
    assert.equal((await f.command('sendText', { text: 'now', requestedDelivery: 'guide' })).status, 'accepted');
    assert.equal(f.actions.at(-1).at(-1), 'steer');
    assert.equal((await f.command('sendText', { text: 'duplicate', requestedDelivery: 'startNow' })).status, 'rejected');
    assert.equal(f.actions.length, 2);
  } finally { f.close(); }
});
test('queue edit/delete use host actions; incompatible immediate send is rejected', async () => {
  const f = fixture();
  try {
    for (const [type, payload, kind] of [
      ['editQueueItem', { queueItemId: 'q', newText: 'edited' }, 'edit'],
      ['deleteQueueItem', { queueItemId: 'q' }, 'remove'],
    ]) {
      assert.equal((await f.command(type, payload)).status, 'accepted');
      assert.equal(f.actions.at(-1).at(-1).kind, kind);
    }
    assert.equal((await f.command('sendQueuedNow', { queueItemId: 'q', modelSelection: { providerId: 'p', modelId: 'm' } })).status, 'rejected');
    assert.equal((await f.command('sendQueuedNow', { queueItemId: 'q' })).status, 'rejected');
  } finally { f.close(); }
});

test('goal projection unwraps the durable snapshot and replay counters', () => {
  const s = summary();
  s.projections.values.goal = { goal: { id: 'goal-1', objective: 'Test', phase: 'active' }, roundsStarted: 3 };
  const c = new Conversation(s, 'epoch', undefined, { goal: true });
  assert.equal(c.snapshot().goal.objective, 'Test');
  assert.equal(c.snapshot().goal.iteration, 2);
  assert.equal(c.snapshot().availability.pauseGoal.allowed, true);
  s.projections.values.goal.goal.phase = 'paused';
  assert.equal(c.snapshot().availability.resumeGoal.allowed, true);
});

test('compaction checkpoint replaces old rows with an explicit completion marker', () => {
  const c = new Conversation(summary(), 'epoch');
  c.event({ seq: 1, time: 1000, type: 'user/message', surfaceOp: { op: 'append' }, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Old' }] } });
  c.event({ seq: 5, time: 2000, type: 'user/message', surfaceOp: { op: 'replace', startSeq: 1, endSeq: 3 }, data: { source: { kind: 'compact-checkpoint', sourceCommandId: 'cmd' }, content: [{ type: 'text', text: 'Model-only compact context' }] } });
  assert.equal(c.snapshot().rows.window.length, 1);
  assert.deepEqual(c.snapshot().rows.window[0].marker, { type: 'compact', origin: 'manual', status: 'success' });
});

test('live reasoning and tool JSON retain their actual content without double encoding', () => {
  const c = new Conversation(summary(), 'epoch');
  c.accept({ type: 'assistant-stream', frame: { type: 'start', attemptId: 'a', startedAfterSeq: 0 } });
  c.accept({ type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'reasoning-delta', index: 0, text: 'Thinking' } } });
  assert.equal(c.snapshot().rows.window[0].text, 'Thinking');
  assert.equal(c.snapshot().rows.window[0].state, 'streaming');
  c.accept({ type: 'assistant-stream', frame: { type: 'end' } });
  c.event({ seq: 1, time: 1000, type: 'tool/call', data: { callId: 'c', name: 'Read', arguments: '{"path":"file.txt"}' } });
  assert.deepEqual(c.snapshot().rows.window[0].input, { path: 'file.txt' });
  assert.equal(c.snapshot().rows.window[0].inputText, '{"path":"file.txt"}');
});

test('direct queue text edits cannot silently discard attachments', async () => {
  const f = fixture();
  f.state.projections.values.inbox = { 'next-turn': [{ id: 'q', content: [{ type: 'file', attachment: {} }] }] };
  try {
    assert.equal((await f.command('editQueueItem', { queueItemId: 'q', newText: 'replace' })).status, 'rejected');
    assert.equal(f.actions.length, 0);
  } finally { f.close(); }
});

test('timed question claim is released on disconnect and never auto-approves', async () => {
  const f = fixture();
  let released = false;
  f.backend.ctx = { userQuestions: { async *attachWait(_agent, _id, signal) {
    try { yield { remainingMs: 10000 }; await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); }
    finally { released = true; }
  } } };
  try {
    const answer = f.backend.interactions.ask('userInput', { agent: { id: 's' }, wait: { callId: 'q', timed: true }, questions: [{ id: 'q', question: 'Confirm?' }] }, () => 'desktop');
    await delay(0);
    const item = f.backend.interactions.list('s')[0];
    assert.equal(item.autoResolution.state, 'visibleCountdown');
    await f.backend.interactions.snooze('/shared', 's', item.interactionId);
    assert.equal(item.autoResolution.state, 'snoozed');
    f.backend.interactions.clear();
    assert.equal(await answer, 'desktop');
    await delay(0);
    assert.equal(released, true);
  } finally { f.close(); }
});

test('plan submission uses the canonical toggle, not an extra prompt', async () => {
  const f = fixture();
  try {
    assert.equal((await f.command('sendText', { text: 'Plan this', planEnabled: true })).status, 'accepted');
    assert.equal(f.actions[0].at(-1), '/plan');
  } finally { f.close(); }
});

test('stop pauses an active goal before cancelling the current turn', async () => {
  const actions = [];
  const backend = new DshBackend({ sessionController: { cancel: async () => actions.push('cancel') } }, ['w']);
  backend.session = async () => ({ projections: { values: { goal: { goal: { phase: 'active' } } } } });
  backend.execute = async (_path, _id, command) => actions.push(command);
  try { await backend.cancel('/shared', 's'); assert.deepEqual(actions, ['/goal pause', 'cancel']); }
  finally { backend.dispose(); }
});
test('goal body is translated to canonical command, never interpreted as control input', async () => {
  const f = fixture();
  try {
    assert.equal((await f.command('sendGoalCommand', { text: 'Implement a fixture' })).status, 'accepted');
    assert.equal(f.actions.at(-1).at(-1), '/goal Implement a fixture');
    assert.equal((await f.command('sendGoalCommand', { text: 'clear' })).status, 'rejected');
    f.state.running = true;
    assert.equal((await f.command('compact', {})).status, 'rejected');
  } finally { f.close(); }
});
test('pin/archive actions use exact shared task identity', async () => {
  const f = fixture();
  try {
    for (const [method, extra, action] of [['setTaskPinned', { pinned: true }, 'pinSession'], ['archiveTask', {}, 'archiveSession'], ['unarchiveTask', {}, 'unarchiveSession']]) {
      await f.bridge.call('zcode-task', method, [{ taskId: 's', workspacePath: '/shared', ...extra }]);
      assert.deepEqual(f.actions.at(-1), ['/shared', 's', action]);
    }
    await assert.rejects(f.bridge.call('zcode-task', 'archiveTask', [{ taskId: 's', workspacePath: '/private' }]));
  } finally { f.close(); }
});
test('projection validates tools, reasoning, queue, usage and interaction wire schema', () => {
  const s = summary();
  s.projections.values = { inbox: { 'next-turn': [{ id: 'q', content: [{ type: 'text', text: 'queued' }] }] }, tokenUsage: { outputTokens: 42 } };
  const c = new Conversation(s, 'epoch', undefined, { fork: true, queueEdit: true });
  for (const event of [
    { seq: 1, type: 'tool/call', data: { callId: 'call', name: 'Read', arguments: { path: 'test.txt' } } },
    { seq: 2, type: 'tool/result', surfaceOp: { op: 'append' }, data: { message: { callId: 'call', content: [{ type: 'text', text: 'output' }] } } },
    { seq: 3, type: 'assistant/message', surfaceOp: { op: 'append' }, data: { message: { content: [{ type: 'reasoning', text: 'Reason' }, { type: 'text', text: 'Done' }] } } },
  ]) c.event({ time: 1000, ...event });
  const snap = c.snapshot();
  assert.equal(snap.rows.window[0].status, 'success');
  assert.equal(snap.rows.window[0].output.text, 'output');
  assert.equal(snap.rows.window[1].kind, 'reasoning');
  assert.equal(snap.rows.window[2].actions.canFork, true);
  assert.equal(snap.queue.items[0].queueItemId, 'q');
  assert.equal(snap.usage.cumulative.outputTokens, 42);
});
test('general file bytes require opt-in and are converted to DSH staged receipts', async () => {
  const bytes = Buffer.from('Test file');
  const uploads = new ImageUploads({ allowFiles: true });
  const common = { sessionId: 's', connectionId: 'c', uploadId: 'u' };
  const metadata = { ...common, mime: 'text/plain', fileName: 'test.txt', totalBytes: bytes.length, totalChunks: 1, checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
  uploads.handle('attachmentBeginV4', '/shared', metadata);
  uploads.handle('attachmentChunkV4', '/shared', { ...common, chunkIndex: 0, dataBase64: bytes.toString('base64') });
  const { ref } = uploads.handle('attachmentCommitV4', '/shared', common);
  const parts = uploads.resolve('/shared', 's', [{ ref, mime: metadata.mime, fileName: metadata.fileName, bytes: bytes.length }]);
  let prompt;
  const backend = new DshBackend({ fileUploads: { upload: async (_agent, input) => { assert.equal(input.data, bytes.toString('base64')); return { receiptId: 'receipt' }; } },
    sessionController: { resolveAgent: async () => ({ agent: {} }), prompt: async p => { prompt = p; } } }, ['w']);
  backend.session = async () => summary();
  try { await backend.prompt('/shared', 's', 'cmd', '', parts); assert.deepEqual(prompt.content, [{ type: 'file', receiptId: 'receipt' }]); }
  finally { backend.dispose(); }
});

test('history ranges use the subscribed immutable cut and reject unbounded requests', async () => {
  const f = fixture();
  try {
    const c = f.bridge.subs.get('test').conversation;
    c.cursor = 100;
    f.backend.page = async (path, id, cursor, before, limit) => {
      assert.deepEqual([path, id, cursor, before, limit], ['/shared', 's', 100, 40, 2]);
      return { records: [{ type: 'event', event: { seq: 19, type: 'session/title', data: { title: 'Old title' } } }, { type: 'event', event: { seq: 20, time: 1000, type: 'assistant/message', surfaceOp: { op: 'append' }, data: { message: { content: [{ type: 'text', text: 'Older message' }] } } } }], hasMore: true };
    };
    const page = await f.bridge.call('zcode-agent', 'conversationRowsRangeV4', { sessionId: 's', beforeRowId: 40, limit: 2 });
    assert.equal(page.rows[0].text, 'Older message'); assert.equal(page.hasMore, true);
    assert.equal(c.summary.projections.values.title, undefined);
    await assert.rejects(f.bridge.call('zcode-agent', 'conversationRowsRangeV4', { sessionId: 's', limit: 100000 }));
  } finally { f.close(); }
});
test('file download authorizes a durable session reference, never an arbitrary storage ID', async () => {
  const attachment = { attachmentId: `sha256:${'a'.repeat(64)}`, bytes: 4, name: 'test.txt' };
  const backend = new DshBackend({ sessionController: {
    async *follow() { yield { type: 'snapshot', cursor: 4, records: [{ type: 'event', event: { type: 'user/message', data: { content: [{ type: 'file', attachment }] } } }], hasMore: false }; },
  }, attachments: { async *readFileStream(ref) { assert.deepEqual(ref, attachment); yield Buffer.from('test'); } } }, ['w']);
  backend.session = async (path, id) => { assert.equal(path, '/shared'); assert.equal(id, 's'); return summary(); };
  try {
    assert.equal((await backend.file('/shared', 's', attachment.attachmentId)).data, Buffer.from('test').toString('base64'));
    await assert.rejects(backend.file('/shared', 's', `sha256:${'b'.repeat(64)}`), /not a supported/);
    await assert.rejects(backend.file('/shared', 's', '../../private'), /Invalid/);
    await assert.rejects(backend.file('/private', 's', attachment.attachmentId));
  } finally { backend.dispose(); }
});
test('queue CAS accepts omitted epoch on current connection but refuses stale revision', async () => {
  const f = fixture();
  try {
    assert.equal((await f.command('deleteQueueItem', { queueItemId: 'q' }, { baseLogEpoch: undefined })).status, 'accepted');
    assert.equal((await f.command('deleteQueueItem', { queueItemId: 'q' }, { baseRevision: 9 })).status, 'stale');
    assert.equal((await f.command('deleteQueueItem', { queueItemId: 'q' }, { baseLogEpoch: 'other' })).status, 'stale');
  } finally { f.close(); }
});
