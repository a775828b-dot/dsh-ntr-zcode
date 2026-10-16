import { writeFile, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Bridge } from '../lib/bridge.js';
import { DshBackend } from '../lib/dsh.js';
export const inject = ['connection', 'webServer', 'sessionController', 'workspaceController', 'sessions', 'approval', 'userQuestions', 'attachments', 'workspaceFiles', 'fileUploads'];
export async function apply(ctx) {
  if (process.env.DSH_NTR_ISOLATED_TEST !== '1') throw new Error('Fixture requires an isolated test profile');
  for (const method of ['checkMode', 'selectModel', 'prompt', 'image', 'queue', 'execute', 'fork', 'membershipAction']) {
    const original = DshBackend.prototype[method];
    DshBackend.prototype[method] = async function (...args) {
      try { return await original.apply(this, args); }
      catch (error) { console.log('NTR_TEST_ERROR', method, error.message, error.data); throw error; }
    };
  }
  const command = Bridge.prototype.command;
  const fail = Bridge.prototype.fail;
  Bridge.prototype.fail = function (error) { console.log('NTR_TEST_SUBSCRIPTION_ERROR', error.stack || error); return fail.call(this, error); };
  let lastBridge;
  const call = Bridge.prototype.call;
  Bridge.prototype.call = async function (...args) {
    try { return await call.apply(this, args); }
    catch (error) { console.log('NTR_TEST_RPC_ERROR', args[0], args[1], error.message); throw error; }
  };
  Bridge.prototype.command = async function (raw) {
    lastBridge = this;
    let result;
    try { result = await command.call(this, raw); }
    catch (error) { console.log('NTR_TEST_PARSE_ERROR', raw.type, raw.payload, error.message); throw error; }
    console.log('NTR_TEST_COMMAND', JSON.stringify({ type: raw.type, keys: Object.keys(raw.payload ?? {}),
      selection: raw.payload?.modelSelection, config: raw.payload?.config, status: result.status, reason: result.reasonCode,
      baseRevision: raw.baseRevision, epochMatches: raw.baseLogEpoch === this.epoch, actualRevision: [...this.subs.values()].find(s => s.conversation?.summary.sessionId === raw.sessionId)?.conversation.seq }));
    return result;
  };
  let sessionId;
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/plugins/ntr-test/previews', methods: ['POST'], requestBody: 'buffered', fetch: async request => {
    const input = await request.json();
    if (input.sessionId !== sessionId) return new Response('Fixture session only', { status: 403 });
    const { createAssistantMessage, createToolResultMessage, createUserMessage } = await import(pathToFileURL(join(process.env.DSH_NTR_SOURCE, 'packages/llm/llm/lib/index.js')).href);
    const data = Buffer.from(input.image, 'base64');
    const ref = await ctx.attachments.saveImage({ data, mediaType: 'image/png', name: 'assistant-output.png' });
    const file = await ctx.attachments.saveFile({ data: Buffer.from('NTR historical text attachment preview'), name: 'history-note.txt' });
    const outputFile = await ctx.attachments.saveFile({ data: Buffer.from('NTR tool file output preview'), name: 'generated report).txt' });
    await writeFile(join(process.env.DSH_NTR_TEST_WORKSPACE, 'local-output.png'), data);
    await writeFile(join(process.env.DSH_NTR_TEST_WORKSPACE, 'result.txt'), 'NTR scoped workspace file preview');
    await writeFile(join(process.env.DSH_NTR_TEST_WORKSPACE, 'unlinked.txt'), 'Not published');
    await writeFile(join(process.env.DSH_NTR_TEST_WORKSPACE, '.env'), 'Not a credential; isolated denial fixture');
    const privateDir = join(process.env.DSH_HOME, 'private-preview-fixture');
    await mkdir(privateDir, { recursive: true });
    await writeFile(join(privateDir, 'outside.txt'), 'Outside workspace; never return this');
    await symlink(privateDir, join(process.env.DSH_NTR_TEST_WORKSPACE, 'escape-preview'), 'junction');
    const session = ctx.sessions.get(sessionId);
    const turn = (session.snapshotEvents().filter(e => e.type === 'turn/start').at(-1)?.data.turn ?? 0) + 1;
    session.append('turn/start', { turn });
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [
      { type: 'text', text: 'NTR preview fixture input' }, { type: 'file', attachment: file }, { type: 'image', attachment: { ...ref, name: 'desktop-input.png' } },
    ] }), { surfaceOp: 'append' });
    session.append('assistant/message', { turn, step: 1, stream: [], message: createAssistantMessage({ source: { provider: 'fixture', model: 'fixture' }, content: [
      { type: 'text', text: 'NTR generated assistant image' }, { type: 'image', attachment: ref },
      { type: 'text', text: '![local-output](./local-output.png)\n\n[Open result.txt](./result.txt)\n\n[Blocked fixture link](./escape-preview/outside.txt)' },
    ] }) }, { surfaceOp: 'append' });
    session.append('tool/call', { turn, step: 1, callId: 'ntr-output-image', name: 'ntr_image_tool', arguments: '{}' });
    session.append('tool/result', { turn, step: 1, message: createToolResultMessage({ callId: 'ntr-output-image', isError: false, content: [
      { type: 'text', text: 'NTR tool-generated image' }, { type: 'image', attachment: { ...ref, name: 'tool-output.png' } },
      { type: 'file', attachment: outputFile },
    ] }) }, { surfaceOp: 'append' });
    session.append('turn/end', { turn, reason: { kind: 'completed' } });
    await ctx.sessions.flush(session);
    const backend = new DshBackend(ctx, null);
    const denied = [];
    let allowed;
    try {
      allowed = (await backend.preview(process.env.DSH_NTR_TEST_WORKSPACE, [sessionId], 'readTextFile', { path: './result.txt' })).content;
      for (const path of ['./unlinked.txt', './.env', './escape-preview/outside.txt', '../private-preview-fixture/outside.txt']) {
        try { await backend.preview(process.env.DSH_NTR_TEST_WORKSPACE, [sessionId], 'readTextFile', { path }); }
        catch { denied.push(path); }
      }
    } finally { backend.dispose(); }
    return Response.json({ ok: true, denied, allowed });
  } }), 'Isolated fixture durable output images and file references');
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/plugins/ntr-test/queue-policy', methods: ['POST'], requestBody: 'buffered', fetch: async request => {
    const input = await request.json();
    if (typeof input.autoDrain !== 'boolean' || !lastBridge || lastBridge.closed) return new Response('Invalid test operation', { status: 400 });
    const conversation = [...lastBridge.subs.values()].find(s => s.conversation?.summary.sessionId === input.sessionId)?.conversation;
    if (!conversation) return new Response('No subscribed fixture session', { status: 400 });
    return Response.json(await lastBridge.command({ type: 'setAutoDrain', commandId: crypto.randomUUID(), clientId: 'test', sessionId: input.sessionId,
      issuedAt: Date.now(), baseRevision: conversation.seq, baseLogEpoch: lastBridge.epoch, payload: { autoDrain: input.autoDrain } }));
  } }), 'Isolated queue policy protocol test');
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/plugins/ntr-test/long-history', methods: ['POST'], requestBody: 'buffered', fetch: async () => {
    const { createUserMessage } = await import(pathToFileURL(join(process.env.DSH_NTR_SOURCE, 'packages/llm/llm/lib/index.js')).href);
    const created = { sessionId };
    const session = ctx.sessions.get(created.sessionId);
    const lastTurn = session.snapshotEvents().filter(e => e.type === 'turn/start').at(-1)?.data.turn ?? 0;
    for (let i = 0; i < 230; i++) {
      session.append('turn/start', { turn: lastTurn + i + 1 });
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `NTR history marker ${String(i).padStart(3, '0')}` }], source: { kind: 'user' } }), { surfaceOp: 'append' });
      session.append('turn/end', { turn: lastTurn + i + 1, reason: { kind: 'completed' } });
    }
    await ctx.sessionController.rename({ sessionId: created.sessionId, title: 'NTR Long History' });
    await ctx.sessions.flush(session);
    return Response.json(created);
  } }), 'Isolated fixture long durable history');
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/plugins/ntr-test/rename', methods: ['POST'], requestBody: 'buffered', fetch: async request => {
    const input = await request.json();
    const known = await ctx.sessionController.list({}, AbortSignal.timeout(15000));
    if (!known.items.some(s => s.sessionId === input.sessionId) || !/^NTR [\w ]{1,60}$/.test(input.title)) return new Response('Invalid fixture rename', { status: 400 });
    await ctx.sessionController.rename(input);
    return Response.json({ ok: true });
  } }), 'Isolated fixture desktop rename');
  const interactions = new Map();
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/plugins/ntr-test/interaction', methods: ['POST', 'GET'], requestBody: 'buffered', fetch: async request => {
    if (request.method === 'GET') return Response.json(Object.fromEntries(interactions));
    const input = await request.json();
    if (input.sessionId !== sessionId) return new Response('Fixture session only', { status: 403 });
    const resolved = await ctx.sessionController.resolveAgent(sessionId);
    if (resolved.error) throw resolved.error;
    const id = crypto.randomUUID();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 60000);
    const promise = input.kind === 'permission'
      ? ctx.approval.request({ agent: resolved.agent, toolName: 'NTR_safe_test', reason: 'Approve this isolated test only; no file or command will run.', signal: abort.signal })
      : ctx.userQuestions.ask({ agent: resolved.agent, signal: abort.signal, questions: [
        { id: 'choice', header: 'Pick', question: 'Choose the fixture color', options: [{ label: 'Red' }, { label: 'Blue' }] },
        { id: 'note', header: 'Note', question: 'Write a fixture note' },
      ] });
    interactions.set(id, { state: 'waiting', kind: input.kind });
    void promise.then(value => interactions.set(id, { state: 'done', value }), error => interactions.set(id, { state: 'error', error: error.message })).finally(() => clearTimeout(timer));
    return Response.json({ id });
  } }), 'Isolated fixture human interactions');
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/plugins/ntr-test/seed', methods: ['POST'], requestBody: 'buffered', fetch: async request => {
    if (new URL(request.url).searchParams.has('blank')) await ctx.workspaceController.create({ path: join(process.env.DSH_HOME, 'second-project') });
    const { workspace } = await ctx.workspaceController.create({ path: process.env.DSH_NTR_TEST_WORKSPACE });
    if (!sessionId) {
      ({ sessionId } = await ctx.sessionController.create({ workspaceId: workspace.workspaceId }, AbortSignal.timeout(15000)));
      if (!new URL(request.url).searchParams.has('blank')) await ctx.sessionController.prompt({ sessionId, requestId: 'ntr-test-seed', mode: 'queue', content: [{ type: 'text', text: 'NTR DSH real host test' }] }, AbortSignal.timeout(15000));
    }
    return Response.json({ sessionId, workspaceId: workspace.workspaceId });
  } }), 'Isolated fixture seed');
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/plugins/ntr-test/directory', methods: ['GET'], requestBody: 'buffered', fetch: async () => {
    const stop = new AbortController();
    const iterator = ctx.workspaceController.follow(stop.signal)[Symbol.asyncIterator]();
    try { const membership = (await iterator.next()).value; return Response.json({ sessions: (await ctx.sessionController.list({}, AbortSignal.timeout(15000))).items, membership }); }
    finally { stop.abort(); await iterator.return?.(); }
  } }), 'Isolated fixture directory');
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/plugins/ntr-test/history', methods: ['GET'], requestBody: 'buffered', fetch: async request => {
    const id = new URL(request.url).searchParams.get('sessionId');
    const stop = new AbortController();
    const iterator = ctx.sessionController.follow({ address: { kind: 'session', sessionId: id }, maxMessages: 50, assistantStream: true }, stop.signal)[Symbol.asyncIterator]();
    try { const first = await iterator.next(); const live = ctx.sessions.get(id); if (live) await ctx.sessions.flush(live); return Response.json({ first }); }
    finally { stop.abort(); await iterator.return?.(); }
  } }), 'Isolated fixture history');
  await writeFile(join(process.env.DSH_HOME, 'test-ready.json'), JSON.stringify({ url: ctx.connection.authenticatedUrl(`http://127.0.0.1:${ctx.webServer.port}/`) }));
}
