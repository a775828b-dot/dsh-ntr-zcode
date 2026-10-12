import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ImageUploads, IMAGE_MAX_BYTES, imageAttachments } from '../lib/images.js';
import { DshBackend } from '../lib/dsh.js';
import { Bridge } from '../lib/bridge.js';
import { remoteMode } from '../lib/projection.js';

const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const begin = { connectionId: 'connection', sessionId: 'session', uploadId: 'upload-1', fileName: 'test.png', mime: 'image/png',
  totalBytes: bytes.length, totalChunks: 1, checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
const terminal = { connectionId: begin.connectionId, sessionId: begin.sessionId, uploadId: begin.uploadId };
const chunk = { ...terminal, chunkIndex: 0, dataBase64: bytes.toString('base64') };
function uploaded(store = new ImageUploads()) {
  store.handle('attachmentBeginV4', '/shared', begin);
  store.handle('attachmentChunkV4', '/shared', chunk);
  const { ref } = store.handle('attachmentCommitV4', '/shared', terminal);
  return { store, ref: { ref, fileName: begin.fileName, mime: begin.mime, bytes: bytes.length } };
}

test('upstream chunk upload supports retry, commit and image-only prompts', async () => {
  const { store, ref } = uploaded();
  assert.equal(store.handle('attachmentBeginV4', '/shared', begin).ref, ref.ref);
  assert.equal(store.handle('attachmentChunkV4', '/shared', chunk).nextChunkIndex, 1);
  assert.equal(store.handle('attachmentCommitV4', '/shared', terminal).ref, ref.ref);
  const calls = [];
  const bridge = new Bridge({ backend: { session: async () => ({ running: false }), prompt: async (...args) => calls.push(args) }, path: '/shared', uploads: store,
    identity: { bridgeSessionId: 'b', bridgeGeneration: 1, recoveryId: 'r' }, send: () => true });
  try {
    const ack = await bridge.command({ commandId: 'image', clientId: 'phone', sessionId: 'session', issuedAt: Date.now(), type: 'sendText', payload: { text: '', attachments: [ref] } });
    assert.equal(ack.status, 'accepted');
    assert.equal(calls[0][4][0].data, bytes.toString('base64'));
  } finally { bridge.dispose(); store.clear(); }
});

test('image upload rejects oversize, non-image, bad checksum and invalid chunk ordering', () => {
  for (const input of [{ ...begin, totalBytes: IMAGE_MAX_BYTES + 1 }, { ...begin, mime: 'image/svg+xml' }, { ...begin, totalChunks: 65 }]) {
    assert.throws(() => new ImageUploads().handle('attachmentBeginV4', '/shared', input));
  }
  const store = new ImageUploads();
  store.handle('attachmentBeginV4', '/shared', { ...begin, checksum: `sha256:${'0'.repeat(64)}` });
  assert.throws(() => store.handle('attachmentChunkV4', '/shared', { ...chunk, chunkIndex: 1 }));
  assert.throws(() => store.handle('attachmentChunkV4', '/shared', { ...chunk, dataBase64: '???=' }));
  store.handle('attachmentChunkV4', '/shared', chunk);
  assert.throws(() => store.handle('attachmentCommitV4', '/shared', terminal), /checksum/);
});

test('image references cannot read paths or cross sessions, workspaces, TTL or stop', () => {
  const { store, ref } = uploaded();
  assert.throws(() => store.resolve('/other', 'session', [ref]));
  assert.throws(() => store.resolve('/shared', 'other', [ref]));
  assert.throws(() => store.resolve('/shared', 'session', [{ ...ref, ref: 'C:/private/key.png' }]));
  assert.throws(() => store.resolve('/shared', 'session', [{ ...ref, mime: 'image/jpeg' }]));
  assert.throws(() => store.resolve('/shared', 'session', Array(5).fill(ref)));
  [...store.items.values()][0].expires = 0;
  assert.throws(() => store.resolve('/shared', 'session', [ref]));
  const fresh = uploaded(); fresh.store.clear();
  assert.throws(() => fresh.store.resolve('/shared', 'session', [fresh.ref]));
});

test('multiple chunks are checksum verified and successful sends release only their own buffers', () => {
  const store = new ImageUploads();
  const data = Buffer.concat([bytes.subarray(0, 8), Buffer.alloc(600000, 42)]);
  const metadata = { ...begin, totalBytes: data.length, totalChunks: 2, checksum: `sha256:${createHash('sha256').update(data).digest('hex')}` };
  store.handle('attachmentBeginV4', '/shared', metadata);
  store.handle('attachmentChunkV4', '/shared', { ...terminal, chunkIndex: 0, dataBase64: data.subarray(0, 384 * 1024).toString('base64') });
  store.handle('attachmentChunkV4', '/shared', { ...terminal, chunkIndex: 1, dataBase64: data.subarray(384 * 1024).toString('base64') });
  const committed = store.handle('attachmentCommitV4', '/shared', terminal);
  const ref = { ...committed, fileName: begin.fileName, mime: begin.mime, bytes: data.length };
  assert.equal(store.resolve('/shared', 'session', [ref])[0].data, data.toString('base64'));
  store.release('/other', 'session', [ref]); assert.equal(store.items.size, 1);
  store.release('/shared', 'session', [ref]); assert.equal(store.items.size, 0);
});

test('durable user images project opaque refs and never source paths', () => {
  assert.deepEqual(imageAttachments([{ type: 'image', attachment: { attachmentId: 'hash', mediaType: 'image/png', bytes: 20, name: 'photo.png' } }]),
    [{ ref: 'dsh-image:hash', mime: 'image/png', bytes: 20, fileName: 'photo.png' }]);
  assert.deepEqual(imageAttachments([{ type: 'image', path: 'C:/secret.png' }]), []);
});

function permissions(allow = true) {
  let preset = 'read-only';
  const commands = [];
  const summary = () => ({ sessionId: 'session', running: false, projections: { values: { permissions: { currentValue: preset } } } });
  const ctx = {
    workspaceController: { async *follow() { yield { type: 'baseline', value: { items: [{ workspaceId: 'shared', path: '/shared', sessionIds: ['session'] }] } }; } },
    sessionController: { list: async () => ({ items: [summary()] }), resolveAgent: async () => ({ agent: { session: {} } }) },
    commands: { execute: async (_agent, line) => { commands.push(line); preset = line.slice('/permission '.length); return { result: { kind: 'success' } }; } },
  };
  return { backend: new DshBackend(ctx, ['shared'], allow), commands, summary, set: value => { preset = value; } };
}
test('three remote modes use canonical DSH commands and project actual permissions', async () => {
  const f = permissions();
  for (const [mode, preset] of [['yolo', 'danger-full-access'], ['edit', 'workspace-write'], ['build', 'read-only']]) {
    await f.backend.checkMode('/shared', 'session', mode);
    assert.equal(f.commands.at(-1), `/permission ${preset}`);
    assert.equal(remoteMode(f.summary()), mode);
  }
  await assert.rejects(f.backend.checkMode('/shared', 'session', 'plan'));
  assert.equal(f.commands.length, 3);
});
test('permission changes require local consent; matching full access works without escalation', async () => {
  const f = permissions(false);
  await assert.rejects(f.backend.checkMode('/shared', 'session', 'yolo'), error => error.reasonCode === 'guard.dshPermissionModeMismatch');
  f.set('danger-full-access');
  await f.backend.checkMode('/shared', 'session', 'yolo');
  assert.deepEqual(f.commands, []);
  f.backend.dispose();
  await assert.rejects(f.backend.checkMode('/shared', 'session', 'edit'));
});

test('image reads reauthorize the DSH session before fetching attachment bytes', async () => {
  let reads = 0;
  const f = permissions();
  f.backend.ctx.sessionController.attachment = async () => { reads++; return { data: bytes.toString('base64'), attachment: { mediaType: 'image/png' } }; };
  await assert.rejects(f.backend.image('/shared', 'private', 'id'));
  assert.equal(reads, 0);
  await f.backend.image('/shared', 'session', 'id');
  assert.equal(reads, 1);
});
