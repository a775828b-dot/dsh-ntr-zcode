import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DshBackend } from '../lib/dsh.js';

function fixture() {
  const archived = [];
  const b = new DshBackend({ workspaceController: { archiveSession: async p => archived.push(p.sessionId) } }, ['w']);
  const summary = { sessionId: 'draft', blank: true, running: false, pinned: false };
  b.session = async (path, id) => { assert.equal(path, '/shared'); assert.equal(id, 'draft'); return summary; };
  b.history = async () => ({ records: [] });
  b.drafts.set('draft', '/shared');
  return { b, summary, archived };
}

test('unused remote drafts are archived recoverably, never deleted', async () => {
  const { b, archived } = fixture();
  assert.equal(await b.discardDraft('/shared', 'draft'), true);
  assert.deepEqual(archived, ['draft']);
  assert.equal(await b.discardDraft('/shared', 'draft'), false);
});

test('draft cleanup refuses existing, foreign, used, running or pinned sessions', async () => {
  for (const change of [s => { s.blank = false; }, s => { s.running = true; }, s => { s.pinned = true; }]) {
    const { b, summary, archived } = fixture(); change(summary);
    assert.equal(await b.discardDraft('/shared', 'draft'), false);
    assert.deepEqual(archived, []);
  }
  const { b, archived } = fixture();
  assert.equal(await b.discardDraft('/private', 'draft'), false);
  assert.equal(await b.discardDraft('/shared', 'existing'), false);
  b.history = async () => ({ records: [{ type: 'event', event: { type: 'user/message' } }] });
  assert.equal(await b.discardDraft('/shared', 'draft'), false);
  b.history = async () => ({ records: [{ type: 'event', event: { type: 'session/title' } }] });
  assert.equal(await b.discardDraft('/shared', 'draft'), false);
  assert.deepEqual(archived, []);
});

test('draft cleanup rechecks ownership and running state after history lookup', async () => {
  for (const action of ['promote', 'run', 'stop']) {
    const { b, summary, archived } = fixture();
    b.history = async () => {
      if (action === 'promote') b.drafts.delete('draft');
      if (action === 'run') summary.running = true;
      if (action === 'stop') b.lifetime.abort();
      return { records: [] };
    };
    if (action === 'stop') await assert.rejects(b.discardDraft('/shared', 'draft'));
    else assert.equal(await b.discardDraft('/shared', 'draft'), false);
    assert.deepEqual(archived, []);
  }
});

test('explicit rename and membership actions retire automatic draft cleanup', async () => {
  for (const action of ['rename', 'pin']) {
    const { b, archived } = fixture();
    b.ctx.sessionController = { rename: async () => ({}) };
    b.ctx.workspaceController.pinSession = async () => ({});
    if (action === 'rename') await b.rename('/shared', 'draft', 'Keep my session');
    else await b.membershipAction('/shared', 'draft', 'pinSession');
    assert.equal(await b.discardDraft('/shared', 'draft'), false);
    assert.deepEqual(archived, []);
  }
});
