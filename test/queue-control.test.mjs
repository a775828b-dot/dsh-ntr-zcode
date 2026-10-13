import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { QueueControl } from '../lib/queue-control.js';
import { DshBackend } from '../lib/dsh.js';
import { Bridge } from '../lib/bridge.js';
import { Conversation } from '../lib/projection.js';

const message = id => ({ id, role: 'user', source: { kind: 'user', rpcId: `rpc-${id}` }, content: [{ type: 'text', text: id }, { type: 'image', attachment: { attachmentId: `image-${id}`, bytes: 10, mediaType: 'image/png', name: `${id}.png` } }] });
function fixture(ids = ['a', 'b', 'c']) {
  let listener, pending = ids.map(message), idle = Promise.resolve();
  const events = [], actions = [], session = { id: 's' };
  const agent = { id: 's', session, status: 'idle', inbox: {
    get nextTurn() { return pending; }, get nextStep() { return []; }, get hasPending() { return pending.length > 0; },
    splice(target, start, count, inserted) { assert.equal(target, 'next-turn'); events.push(['splice', structuredClone(inserted)]); return pending.splice(start, count, ...inserted); },
    remove(id) { const i = pending.findIndex(m => m.id === id); if (i >= 0) pending.splice(i, 1); },
    append(target, item) { pending.push(item); },
  }, cancel(cause, options) { actions.push(['cancel', options]); agent.status = 'idle'; },
  whenIdle: () => idle,
  send(item, target, wake) { pending.push(item); actions.push(['wake', pending.map(m => m.id)]); agent.status = 'running'; listener(session, { type: 'turn/start' }); },
  };
  const ctx = { on(name, fn) { assert.equal(name, 'session/event'); listener = fn; return () => { listener = () => {}; }; },
    sessionController: { resolveAgent: async () => ({ agent }), cancel: () => agent.cancel({}, { keepInbox: true }) },
  };
  const queues = new QueueControl(ctx);
  const backend = new DshBackend(ctx, ['w'], false, queues);
  const summary = { sessionId: 's', running: false, projections: { values: {} } };
  backend.session = async (p, id) => { backend.lifetime.signal.throwIfAborted(); assert.equal(p, '/shared'); assert.equal(id, 's'); return { ...summary, running: agent.status === 'running' }; };
  const bridge = new Bridge({ backend, path: '/shared', identity: { bridgeSessionId: 'b', bridgeGeneration: 1, recoveryId: 'r' }, send: () => true });
  bridge.subs.set('test', { id: 'test', controller: new AbortController(), conversation: new Conversation(summary, bridge.epoch, undefined, { sendQueuedNow: true }) });
  const command = (type, payload, extra = {}) => bridge.command({ commandId: crypto.randomUUID(), clientId: 'phone', sessionId: 's', issuedAt: Date.now(), type, payload, baseRevision: 0, baseLogEpoch: bridge.epoch, ...extra });
  return { queues, agent, backend, bridge, command, events, actions, ids: () => pending.map(m => m.id),
    turn: () => listener(session, { type: 'turn/start' }), otherTurn: () => listener({ id: 'private' }, { type: 'turn/start' }),
    block: promise => { idle = promise; }, close() { backend.dispose(); bridge.dispose(); queues.dispose(); } };
}

test('reorder performs one durable splice and preserves IDs, attachments and source receipts', async () => {
  const f = fixture();
  try {
    const originals = structuredClone(f.agent.inbox.nextTurn);
    await f.backend.reorderQueue('/shared', 's', 'c', 'a');
    assert.deepEqual(f.ids(), ['c', 'a', 'b']);
    assert.equal(f.events.length, 1);
    assert.deepEqual(f.agent.inbox.nextTurn[0], originals[2]);
    await f.backend.reorderQueue('/shared', 's', 'c', null);
    assert.deepEqual(f.ids(), ['a', 'b', 'c']);
    await f.backend.reorderQueue('/shared', 's', 'a', 'a');
    assert.equal(f.events.length, 2);
  } finally { f.close(); }
});
test('missing item or anchor never changes or wakes the queue', async () => {
  const f = fixture();
  try {
    for (const [id, anchor] of [['missing', null], ['a', 'missing']]) await assert.rejects(f.backend.reorderQueue('/shared', 's', id, anchor));
    assert.deepEqual(f.ids(), ['a', 'b', 'c']); assert.equal(f.events.length, 0); assert.equal(f.actions.length, 0);
  } finally { f.close(); }
});
test('200 deterministic reorder operations preserve every original occurrence', async () => {
  const ids = Array.from({ length: 12 }, (_, i) => `q${i}`), f = fixture(ids);
  const expected = [...ids];
  try {
    for (let n = 0; n < 200; n++) {
      const id = ids[(n * 7) % ids.length], before = n % 5 === 0 ? null : ids[(n * 11 + 3) % ids.length];
      if (id !== before) { expected.splice(expected.indexOf(id), 1); expected.splice(before === null ? expected.length : expected.indexOf(before), 0, id); }
      await f.backend.reorderQueue('/shared', 's', id, before);
      assert.deepEqual(f.ids(), expected);
      assert.deepEqual([...f.agent.inbox.nextTurn].sort((a, b) => a.id.localeCompare(b.id)), ids.map(message).sort((a, b) => a.id.localeCompare(b.id)));
    }
  } finally { f.close(); }
});
test('model preflight failure cannot cancel or mutate a live queue', async () => {
  const f = fixture();
  try {
    f.agent.status = 'running'; f.backend.models = async () => ({ groups: [], default: {}, failures: [] });
    await assert.rejects(f.backend.sendQueuedNow('/shared', 's', 'b', { providerId: 'missing', modelId: 'missing' }));
    assert.equal(f.agent.status, 'running'); assert.equal(f.actions.length, 0); assert.deepEqual(f.ids(), ['a', 'b', 'c']);
  } finally { f.close(); }
});
test('scope revoked during immediate-stop wait prevents restart', async () => {
  const f = fixture(); let release;
  try {
    f.block(new Promise(r => { release = r; }));
    const pending = f.backend.sendQueuedNow('/shared', 's', 'a');
    await delay(5); f.backend.session = async () => { throw new Error('unshared'); }; release();
    await assert.rejects(pending, /unshared/); assert(!f.actions.some(a => a[0] === 'wake')); assert.equal(f.queues.autoDrain('s'), false);
  } finally { release?.(); f.close(); }
});
test('pause does not interrupt current work; next turn is gated before input claim', async () => {
  const f = fixture();
  try {
    f.agent.status = 'running';
    await f.backend.setAutoDrain('/shared', 's', false);
    assert.equal(f.actions.length, 0);
    f.otherTurn(); assert.equal(f.actions.length, 0);
    f.turn(); assert.deepEqual(f.actions, [['cancel', { keepInbox: true }]]);
    assert.deepEqual(f.ids(), ['a', 'b', 'c']);
    await f.backend.setAutoDrain('/shared', 's', true);
    assert.deepEqual(f.actions.at(-1), ['wake', ['a', 'b', 'c']]);
    assert.equal(f.agent.status, 'running');
  } finally { f.close(); }
});
test('resume while busy arms consumption without duplicating or waking input', async () => {
  const f = fixture();
  try { f.agent.status = 'running'; await f.backend.setAutoDrain('/shared', 's', true); assert.equal(f.actions.length, 0); assert.deepEqual(f.ids(), ['a', 'b', 'c']); }
  finally { f.close(); }
});
test('empty resume does not manufacture a prompt', async () => {
  const f = fixture([]);
  try { await f.backend.setAutoDrain('/shared', 's', true); assert.equal(f.actions.length, 0); }
  finally { f.close(); }
});
test('immediate send waits for actual idle then promotes exact item without losing others', async () => {
  const f = fixture(); let release;
  try {
    f.agent.status = 'running'; f.block(new Promise(r => { release = r; }));
    const pending = f.backend.sendQueuedNow('/shared', 's', 'c');
    await delay(10);
    assert.deepEqual(f.actions, [['cancel', { keepInbox: true }]]);
    assert.equal(f.queues.autoDrain('s'), false); assert.deepEqual(f.ids(), ['a', 'b', 'c']);
    release(); await pending;
    assert.deepEqual(f.actions.at(-1), ['wake', ['c', 'a', 'b']]);
    assert.equal(f.queues.autoDrain('s'), true);
  } finally { release?.(); f.close(); }
});
test('lost target during stop leaves remaining queue paused, never sends another item', async () => {
  const f = fixture(); let release;
  try {
    f.block(new Promise(r => { release = r; }));
    const pending = f.backend.sendQueuedNow('/shared', 's', 'b');
    await delay(5); f.agent.inbox.remove('b'); release();
    await assert.rejects(pending, /no longer pending/);
    assert.deepEqual(f.ids(), ['a', 'c']); assert.equal(f.queues.autoDrain('s'), false);
    assert(!f.actions.some(a => a[0] === 'wake'));
  } finally { release?.(); f.close(); }
});
test('stop/revocation while waiting prevents promotion and wake', async () => {
  const f = fixture(); let release;
  try {
    f.block(new Promise(r => { release = r; }));
    const pending = f.backend.sendQueuedNow('/shared', 's', 'b');
    await delay(5); f.backend.dispose(); await assert.rejects(pending);
    release(); await delay(0);
    assert.deepEqual(f.ids(), ['a', 'b', 'c']); assert(!f.actions.some(a => a[0] === 'wake'));
  } finally { release?.(); f.close(); }
});
test('queue mutations are serialized around an in-flight immediate send', async () => {
  const f = fixture(); let release;
  try {
    f.block(new Promise(r => { release = r; }));
    const send = f.backend.sendQueuedNow('/shared', 's', 'c');
    const pause = f.backend.setAutoDrain('/shared', 's', false);
    await delay(5); release(); await Promise.all([send, pause]);
    assert.equal(f.queues.autoDrain('s'), false); assert.deepEqual(f.ids(), ['c', 'a', 'b']);
  } finally { release?.(); f.close(); }
});
test('a newer stop supersedes a waiting immediate send', async () => {
  const f = fixture(); let release;
  try {
    f.block(new Promise(r => { release = r; }));
    const send = f.backend.sendQueuedNow('/shared', 's', 'c');
    await delay(5); await f.backend.cancel('/shared', 's'); release();
    await assert.rejects(send, /superseded/);
    assert.equal(f.queues.autoDrain('s'), false); assert.deepEqual(f.ids(), ['a', 'b', 'c']);
    assert(!f.actions.some(a => a[0] === 'wake'));
  } finally { release?.(); f.close(); }
});
test('resume during stop convergence waits for idle and wakes exactly once', async () => {
  const f = fixture(); let release;
  try {
    f.block(new Promise(r => { release = r; }));
    await f.backend.cancel('/shared', 's'); f.agent.status = 'running';
    const resume = f.backend.setAutoDrain('/shared', 's', true);
    await delay(5); assert(!f.actions.some(a => a[0] === 'wake'));
    f.agent.status = 'idle'; release(); await resume;
    assert.equal(f.actions.filter(a => a[0] === 'wake').length, 1);
    assert.deepEqual(f.ids(), ['a', 'b', 'c']);
  } finally { release?.(); f.close(); }
});
test('wake failure restores the original tail and its attachments', async () => {
  const f = fixture();
  try {
    f.agent.send = () => { throw new Error('wake unavailable'); };
    await assert.rejects(f.backend.setAutoDrain('/shared', 's', true), /wake unavailable/);
    assert.deepEqual(f.agent.inbox.nextTurn, ['a', 'b', 'c'].map(message));
  } finally { f.close(); }
});
test('unshared session fails before any queue side effect', async () => {
  const f = fixture();
  try { await assert.rejects(f.backend.sendQueuedNow('/private', 's', 'a')); await assert.rejects(f.backend.setAutoDrain('/private', 's', false)); assert.equal(f.actions.length, 0); }
  finally { f.close(); }
});
test('wire reorder, pause and immediate commands reach backend, replay executes once', async () => {
  const f = fixture();
  try {
    assert.equal((await f.command('reorderQueueItem', { queueItemId: 'c', beforeQueueItemId: 'a' })).status, 'accepted');
    assert.deepEqual(f.ids(), ['c', 'a', 'b']);
    assert.equal((await f.command('setAutoDrain', { autoDrain: false })).status, 'accepted');
    const id = crypto.randomUUID();
    const result = await Promise.all([f.command('sendQueuedNow', { queueItemId: 'b' }, { commandId: id }), f.command('sendQueuedNow', { queueItemId: 'b' }, { commandId: id })]);
    assert(result.every(r => r.status === 'accepted')); assert.equal(f.actions.filter(a => a[0] === 'wake').length, 1);
    assert.deepEqual(f.ids(), ['b', 'c', 'a']);
  } finally { f.close(); }
});
test('all three wire operations reject stale revision, wrong epoch and unknown payload', async () => {
  const f = fixture();
  try {
    for (const [type, p] of [['reorderQueueItem', { queueItemId: 'a', beforeQueueItemId: null }], ['setAutoDrain', { autoDrain: false }], ['sendQueuedNow', { queueItemId: 'a' }]]) {
      assert.equal((await f.command(type, p, { baseRevision: 99 })).status, 'stale');
      assert.equal((await f.command(type, p, { baseLogEpoch: 'old' })).status, 'stale');
      assert.equal((await f.command(type, { ...p, unexpected: true })).status, 'rejected');
    }
    assert.equal(f.actions.length, 0); assert.equal(f.events.length, 0);
  } finally { f.close(); }
});
test('stream-only revision changes do not invalidate a previously observed unchanged queue', async () => {
  const f = fixture();
  try {
    const sub = f.bridge.subs.get('test');
    sub.queueVersions = new Map([[0, JSON.stringify(sub.conversation.snapshot().queue)]]);
    sub.conversation.seq = 1;
    assert.equal((await f.command('reorderQueueItem', { queueItemId: 'c', beforeQueueItemId: 'a' })).status, 'accepted');
    assert.deepEqual(f.ids(), ['c', 'a', 'b']);
    sub.conversation.autoDrain = false;
    assert.equal((await f.command('setAutoDrain', { autoDrain: true })).status, 'stale');
    assert.equal((await f.command('sendQueuedNow', { queueItemId: 'c' }, { baseRevision: 33 })).status, 'stale');
  } finally { f.close(); }
});
test('pause survives backend reconnect and is projected as held enqueue, not startNow', async () => {
  const f = fixture();
  try {
    await f.backend.setAutoDrain('/shared', 's', false); f.backend.dispose();
    const c = new Conversation({ sessionId: 's', projections: { values: { inbox: { 'next-turn': f.agent.inbox.nextTurn } } } }, 'epoch', undefined, { queueEdit: true, sendQueuedNow: true });
    c.autoDrain = f.queues.autoDrain('s');
    assert.equal(c.snapshot().queue.autoDrain, false); assert.equal(c.snapshot().queue.pauseReason, 'stopped');
    assert.equal(c.snapshot().inputRouting.mode, 'enqueue'); assert.equal(c.snapshot().availability.sendQueuedNow.allowed, true);
    f.turn(); assert.equal(f.actions.at(-1)[0], 'cancel');
  } finally { f.close(); }
});
