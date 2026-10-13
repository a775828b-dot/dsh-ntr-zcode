import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Conversation } from '../lib/projection.js';

const conversation = () => new Conversation({ sessionId: 'audit', running: false, projections: { values: {} } }, 'epoch');
function event(c, seq, type, data, surfaceOp) {
  c.accept({ type: 'event', event: { seq, time: seq * 1000, type, data, ...(surfaceOp ? { surfaceOp } : {}) } });
}

test('stopping the latest turn never changes completed historical turn states', () => {
  const c = conversation();
  for (const turn of [1, 2, 3]) {
    const seq = turn * 10;
    event(c, seq, 'turn/start', { turn });
    event(c, seq + 1, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: `input ${turn}` }] }, { op: 'append' });
    event(c, seq + 2, 'assistant/message', { turn, message: { content: [{ type: 'text', text: `reply ${turn}` }] } }, { op: 'append' });
    event(c, seq + 3, 'turn/end', { turn, reason: { kind: turn === 3 ? 'aborted' : 'completed' } });
  }
  const snapshot = c.snapshot();
  assert.equal(snapshot.control.phase, 'completedInterrupted');
  assert.deepEqual(snapshot.rows.window.filter(r => r.kind === 'turnHeader').map(r => r.state), ['completedSuccess', 'completedSuccess', 'completedInterrupted']);
  for (const turn of [1, 2, 3]) {
    const rows = snapshot.rows.window.filter(r => r.turnId === `turn-${turn}`);
    assert.deepEqual(rows.map(r => r.kind), ['turnHeader', 'userInput', 'assistantText']);
    assert.equal(rows[0].endedAt, (turn * 10 + 3) * 1000);
    assert.equal(rows[0].activeMs, undefined);
  }
});

test('old interrupted tools do not revive when a new turn starts', () => {
  const c = conversation();
  event(c, 1, 'turn/start', { turn: 1 });
  event(c, 2, 'tool/call', { turn: 1, callId: 'old', name: 'read', arguments: '{}' });
  event(c, 3, 'turn/end', { turn: 1, reason: { kind: 'aborted' } });
  event(c, 4, 'turn/start', { turn: 2 });
  event(c, 5, 'tool/call', { turn: 2, callId: 'new', name: 'read', arguments: '{}' });
  assert.deepEqual(c.snapshot().rows.window.filter(r => r.kind === 'toolCall').map(r => r.status), ['cancelled', 'running']);
});

test('goal continuation gets its own authoritative turn, not the previous user turn', () => {
  const c = conversation();
  event(c, 1, 'turn/start', { turn: 2 });
  event(c, 2, 'user/message', { source: { kind: 'goal' }, content: [{ type: 'text', text: 'internal goal prompt' }] }, { op: 'append' });
  event(c, 3, 'assistant/message', { turn: 2, message: { content: [{ type: 'text', text: 'continued' }] } }, { op: 'append' });
  event(c, 4, 'turn/end', { turn: 2, reason: { kind: 'error' } });
  const rows = c.snapshot().rows.window;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].origin, 'goalContinuation');
  assert.equal(rows[0].state, 'failed');
  assert.equal(rows[0].turnId, rows[1].turnId);
});

test('a resync without an active attempt drops stale streaming content', () => {
  const c = conversation();
  c.accept({ type: 'assistant-stream', frame: { type: 'start', attemptId: 'old', startedAfterSeq: 20 } });
  c.accept({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'old', chunk: { type: 'text-delta', text: 'stale' } } });
  assert.equal(c.snapshot().rows.window.length, 1);
  c.accept({ type: 'snapshot', records: [], projections: { values: {} }, hasMore: false, cursor: 0 });
  assert.deepEqual(c.snapshot().rows.window, []);
  assert.equal(c.maxSeq, 0);
});

test('late chunks and end frames from an older attempt cannot corrupt the active reply', () => {
  const c = conversation();
  c.accept({ type: 'assistant-stream', frame: { type: 'start', attemptId: 'new', startedAfterSeq: 20 } });
  for (const attemptId of ['old', 'new']) c.accept({ type: 'assistant-stream', frame: {
    type: 'chunk', attemptId, chunk: { type: 'text-delta', text: attemptId },
  } });
  c.accept({ type: 'assistant-stream', frame: { type: 'end', attemptId: 'old' } });
  assert.equal(c.snapshot().rows.window[0].text, 'new');
  c.accept({ type: 'assistant-stream', frame: { type: 'end', attemptId: 'new' } });
  assert.deepEqual(c.snapshot().rows.window, []);
});
