import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DshBackend } from '../lib/dsh.js';
import { Bridge } from '../lib/bridge.js';
import { Conversation } from '../lib/projection.js';
import { imageAttachments } from '../lib/images.js';
import { previewPath, markdownLinks, imageMarkdown, fileMarkdown, outputImageRef, imageMediaType } from '../lib/previews.js';

const id = `sha256:${'a'.repeat(64)}`;
const image = { type: 'image', attachment: { attachmentId: id, name: 'generated.png', mediaType: 'image/png', bytes: 8 } };
const png = Buffer.from('89504e470d0a1a0a', 'hex');
function fixture({ data = Buffer.from('hello preview'), links = '[file](./result.txt)', actual = '/shared/result.txt' } = {}) {
  const calls = [];
  const b = new DshBackend({ workspaceFiles: {
    stat: async () => ({ absolutePath: actual, bytes: data.length, version: 'v1' }),
    readBytes: async (scope, path, options) => {
      calls.push({ scope, path, options });
      const { offset, length } = options.range;
      return { absolutePath: actual, version: 'v1', data: data.subarray(offset, offset + length) };
    },
  } }, ['w']);
  b.session = async (_path, session) => { if (session !== 's') throw new Error('unshared'); return {}; };
  b.history = async (_path, session) => { await b.session(_path, session); return { records: [{ event: {
    type: 'assistant/message', data: { message: { content: [{ type: 'text', text: links }] } },
  } }] }; };
  return { b, calls };
}
test('Markdown parser recognizes references and angle paths but not fenced examples', () => {
  const links = markdownLinks([{ type: 'text', text: '[file][f]\n\n[f]: <./a file.txt>\n\n![p](./a.png)\n\n```md\n[x](./secret.txt)\n```' }]);
  assert.deepEqual([...links].sort(), ['./a file.txt', './a.png']);
});
test('preview paths contain POSIX and Windows targets and decode exactly once', () => {
  assert.equal(previewPath('/shared', './a%20b.txt#L3'), '/shared/a b.txt');
  assert.equal(previewPath('D:\\shared', '/D:/shared/a.txt:12'), 'D:\\shared\\a.txt');
  for (const p of ['../secret', '/shared-other/key', '%2e%2e/secret', './.env', './a/.git/config', 'https://host/a', 'file:///secret', '//host/share', 'a%00.png']) assert.throws(() => previewPath('/shared', p));
  for (const p of ['C:\\private\\a', 'D:\\shared2\\a', '\\\\server\\share', 'D:relative', 'a.txt:secret', 'dir. /a', '.ssh/key']) assert.throws(() => previewPath('D:\\shared', p));
});
test('assistant image-only and tool image results become original artifact-image Markdown', () => {
  const c = new Conversation({ sessionId: 's', projections: { values: {} } }, 'e');
  for (const [seq, type, data] of [
    [1, 'turn/start', { turn: 1 }],
    [2, 'assistant/message', { message: { content: [image] } }],
    [3, 'tool/call', { callId: 'tool', name: 'read_image', arguments: '{}' }],
    [4, 'tool/result', { message: { toolCallId: 'tool', content: [image], isError: false } }],
  ]) c.accept({ type: 'event', event: { seq, type, time: seq, data, surfaceOp: { op: 'append' } } });
  const rows = c.snapshot().rows.window;
  assert.equal(rows.filter(r => r.kind === 'assistantText').length, 2);
  assert(rows.find(r => r.kind === 'assistantText').text.includes(outputImageRef(id)));
  assert(rows.at(-1).text.includes('DSH tool output: read_image'));
  assert.equal(rows.find(r => r.kind === 'toolCall').status, 'success');
  assert.equal(imageMarkdown([{ ...image, attachment: { ...image.attachment, mediaType: 'image/svg+xml' } }]), '');
});
test('file attachment names select safe MIME hints for original history preview', () => {
  assert.equal(imageAttachments([{ type: 'file', attachment: { attachmentId: id, name: 'note.txt', bytes: 5 } }])[0].mime, 'text/plain');
  const links = markdownLinks([{ type: 'text', text: fileMarkdown([{ type: 'file', attachment: { attachmentId: id, name: 'a) note.txt' } }]) }]);
  assert.equal(links.size, 1);
  assert([...links][0].endsWith('a%29%20note.txt'));
});
test('linked text preview is read through scoped DSH service with bounded bytes', async () => {
  const { b, calls } = fixture();
  const result = await b.preview('/shared', ['s'], 'readTextFile', { path: '/shared/result.txt', offset: 6, length: 7 });
  assert.equal(result.content, 'preview'); assert.equal(result.totalBytes, 13);
  assert.deepEqual(calls[0].scope, { sessionId: 's', workspaceRoot: '/shared' });
});
test('file preview never reads guessed paths, no subscription or a foreign session', async () => {
  const { b, calls } = fixture();
  for (const ids of [[], ['private']]) await assert.rejects(b.preview('/shared', ids, 'readTextFile', { path: './result.txt' }));
  await assert.rejects(b.preview('/shared', ['s'], 'readTextFile', { path: './guessed.txt' }));
  assert.equal(calls.length, 0);
});
test('resolved symlink escape fails before file bytes are read', async () => {
  const { b, calls } = fixture({ actual: '/private/key' });
  await assert.rejects(b.preview('/shared', ['s'], 'readTextFile', { path: './result.txt' }), /outside/);
  assert.equal(calls.length, 0);
});
test('file changing identity or version while reading is never returned', async () => {
  for (const change of [{ absolutePath: '/private/key' }, { version: 'v2' }]) {
    const { b } = fixture();
    const original = b.ctx.workspaceFiles.readBytes;
    b.ctx.workspaceFiles.readBytes = async (...args) => ({ ...await original(...args), ...change });
    await assert.rejects(b.preview('/shared', ['s'], 'readTextFile', { path: './result.txt' }));
  }
});
test('preview revocation and backend disposal discard in-flight bytes', async () => {
  for (const stopped of [false, true]) {
    const { b } = fixture();
    const original = b.ctx.workspaceFiles.readBytes;
    b.ctx.workspaceFiles.readBytes = async (...args) => {
      if (stopped) b.dispose(); else b.session = async () => { throw new Error('revoked'); };
      return original(...args);
    };
    await assert.rejects(b.preview('/shared', ['s'], 'readTextFile', { path: './result.txt' }));
  }
});
test('oversized files and malformed ranges are rejected', async () => {
  for (const params of [{ offset: -1 }, { length: 0.5 }, { length: 300000 }, { offset: Infinity }, { maxBytes: 1 }]) {
    const { b, calls } = fixture();
    await assert.rejects(b.preview('/shared', ['s'], 'readTextFile', { path: './result.txt', ...params }));
    assert.equal(calls.length, 0);
  }
  const { b } = fixture(); b.ctx.workspaceFiles.stat = async () => ({ absolutePath: '/shared/result.txt', bytes: 8388609 });
  await assert.rejects(b.preview('/shared', ['s'], 'readBinaryPreview', { path: './result.txt' }), /8 MiB/);
});
test('image preview verifies bytes rather than trusting extension; text rejects binary', async () => {
  const { b } = fixture({ data: png });
  assert.equal((await b.preview('/shared', ['s'], 'readMediaPreview', { path: './result.txt' })).mediaType, 'image/png');
  assert.throws(() => imageMediaType(Buffer.from('<svg/>')));
  const binary = fixture({ data: Buffer.from([0, 1, 2]) }).b;
  assert.equal((await binary.preview('/shared', ['s'], 'readTextFile', { path: './result.txt' })).isBinary, true);
});
test('wire artifact image reads preserve session authorization and chunk boundaries', async () => {
  const calls = [];
  const bridge = new Bridge({ backend: { image: async (...args) => { calls.push(args); return { attachment: { mediaType: 'image/png' }, data: png.toString('base64') }; } },
    path: '/shared', identity: { bridgeSessionId: 'b', bridgeGeneration: 1, recoveryId: 'r' }, send: () => true });
  try {
    const result = await bridge.call('zcode-agent', 'attachmentReadV4', [{ sessionId: 's', ref: outputImageRef(id), offset: 2, limit: 3 }]);
    assert.deepEqual(calls, [['/shared', 's', id]]);
    assert.equal(result.dataBase64, png.subarray(2, 5).toString('base64')); assert.equal(result.nextOffset, 5);
    await assert.rejects(bridge.call('zcode-agent', 'attachmentReadV4', [{ sessionId: 's', ref: 'zcode-artifact://dsh/image/../../key', offset: 0, limit: 3 }]));
  } finally { bridge.dispose(); }
});
test('virtual attachment links read only durable references from subscribed sessions', async () => {
  const { b, calls } = fixture();
  const file = { type: 'file', attachment: { attachmentId: id, name: 'a note.txt', bytes: 5 } };
  const link = [...markdownLinks([{ type: 'text', text: fileMarkdown([file]) }])][0];
  const reads = [];
  b.file = async (path, session, ref) => {
    reads.push([path, session, ref]);
    if (session !== 's' || ref !== id) throw new Error('not referenced');
    return { attachment: file.attachment, data: Buffer.from('hello').toString('base64') };
  };
  assert.equal((await b.preview('/shared', ['s'], 'readTextFile', { path: link })).content, 'hello');
  assert.deepEqual(reads[0], ['/shared', 's', id]);
  assert.equal(calls.length, 0);
  await assert.rejects(b.preview('/shared', ['private'], 'readTextFile', { path: link }));
  await assert.rejects(b.preview('/shared', ['s'], 'readTextFile', { path: link.replace('a%20note.txt', 'spoof.txt') }));
});
test('preview references never alter the original user text or attachment identity', () => {
  const c = new Conversation({ sessionId: 's', projections: { values: {} } }, 'e');
  c.accept({ type: 'event', event: { seq: 1, time: 1, type: 'user/message', surfaceOp: { op: 'append' }, data: {
    source: { kind: 'user' }, content: [{ type: 'text', text: 'original input' }, { type: 'file', attachment: { attachmentId: id, name: 'report.txt', bytes: 5 } }],
  } } });
  const rows = c.snapshot().rows.window;
  assert.equal(rows[0].text, 'original input'); assert.equal(rows[0].attachments[0].ref, `dsh-file:${id}`);
  assert(rows[1].text.startsWith('**DSH attachment preview**')); assert.equal(rows[1].actions, undefined);
  assert.notEqual(rows[0].rowId, rows[1].rowId);
});
test('bridge rejects file mutation and ignores sessions outside active subscriptions', async () => {
  const calls = [];
  const bridge = new Bridge({ backend: { preview: async (...args) => { calls.push(args); return {}; } }, path: '/shared',
    identity: { bridgeSessionId: 'b', bridgeGeneration: 1, recoveryId: 'r' }, send: () => true });
  try {
    await assert.rejects(bridge.call('file', 'stat', [{ path: './result.txt', workspacePath: '/private' }]), /Workspace mismatch/);
    await bridge.call('file', 'stat', [{ path: './result.txt', sessionId: 'invented' }]);
    assert.deepEqual(calls[0][1], []);
    for (const method of ['writeFile', 'readdir', 'createDefaultWorkspace']) await assert.rejects(bridge.call('file', method, [{ path: './result.txt' }]));
  } finally { bridge.dispose(); }
});
