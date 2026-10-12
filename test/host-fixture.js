import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Bridge } from '../lib/bridge.js';
import { DshBackend } from '../lib/dsh.js';
export const inject = ['connection', 'webServer', 'sessionController', 'workspaceController', 'sessions'];
export async function apply(ctx) {
  if (process.env.DSH_NTR_ISOLATED_TEST !== '1') throw new Error('Fixture requires an isolated test profile');
  for (const method of ['checkMode', 'selectModel', 'prompt', 'image']) {
    const original = DshBackend.prototype[method];
    DshBackend.prototype[method] = async function (...args) {
      try { return await original.apply(this, args); }
      catch (error) { console.log('NTR_TEST_ERROR', method, error.message, error.data); throw error; }
    };
  }
  const command = Bridge.prototype.command;
  Bridge.prototype.command = async function (raw) {
    const result = await command.call(this, raw);
    console.log('NTR_TEST_COMMAND', JSON.stringify({ type: raw.type, keys: Object.keys(raw.payload ?? {}),
      selection: raw.payload?.modelSelection, config: raw.payload?.config, status: result.status, reason: result.reasonCode }));
    return result;
  };
  let sessionId;
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
    return Response.json({ sessions: (await ctx.sessionController.list({}, AbortSignal.timeout(15000))).items });
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
