import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../lib/bridge.js';
import { catalogModelView, resolveSelection, toRemoteSelection } from '../lib/model-view.js';
import { DshBackend } from '../lib/dsh.js';
import { Conversation } from '../lib/projection.js';

const catalog = { default: { provider: 'provider', model: 'model', reasoningEffort: 'low' },
  groups: [{ id: 'provider', name: 'Provider', models: [{ id: 'model', name: 'Model', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'low' } }, { id: 'plain', name: 'Plain' }] }], failures: [] };
const selection = { providerId: 'provider', modelId: 'model', options: { reasoningLevel: 'high' } };
const envelope = (payload = {}, id = 'create') => ({ commandId: id, clientId: 'mobile', sessionId: null, type: 'createSession', issuedAt: Date.now(), payload: { workspaceId: '/shared', ...payload } });
function setup() {
  const writes = [];
  const backend = { workspace: async path => { assert.equal(path, '/shared'); return {}; }, models: async () => catalog,
    create: async (...args) => { writes.push(['create', ...args]); return 'new-id'; },
    prompt: async (...args) => { writes.push(['prompt', ...args]); },
    session: async () => ({ sessionId: 'new-id', running: false }),
    selectModel: async (...args) => { writes.push(['select', ...args]); return resolveSelection(catalog, args[2]); },
  };
  return { writes, backend, bridge: new Bridge({ backend, path: '/shared', identity: { bridgeSessionId: 'b', bridgeGeneration: 1, recoveryId: 'r' }, send: () => true }) };
}

test('real catalog exposes enabled models and actual reasoning levels without credentials', () => {
  const view = catalogModelView(catalog);
  assert.equal(view.providers[0].models[0].config.enabled, true);
  assert.equal(view.providers[0].config.api.type, 'openai-chat-completions');
  assert.equal(view.providers[0].config.api.baseUrl, undefined);
  assert.equal(view.providers[0].config.access, undefined);
  assert.deepEqual(view.providers[0].models[0].config.optionSpecs.reasoningLevel.values, ['low', 'high']);
  assert.equal(catalogModelView(catalog, { selection }).effectiveSelection.options.reasoningLevel, 'high');
  assert.deepEqual(resolveSelection(catalog, selection), { provider: 'provider', model: 'model', reasoningEffort: 'high' });
  assert.throws(() => resolveSelection(catalog, { ...selection, options: { reasoningLevel: 'ultra' } }));
  assert.throws(() => resolveSelection(catalog, { ...selection, modelId: 'missing' }));
  assert.deepEqual(resolveSelection(catalog, toRemoteSelection({ provider: 'provider', model: 'plain' }, catalog)), { provider: 'provider', model: 'plain' });
});

test('null-session creation and first input are deduplicated and use the real created ID', async () => {
  const f = setup();
  try {
    const c = envelope({ firstInput: { text: 'hello', modelSelection: selection }, config: { modelSelection: selection, mode: 'build', planEnabled: false } });
    const [a, b] = await Promise.all([f.bridge.command(c), f.bridge.command(c)]);
    assert.equal(a.status, 'accepted'); assert.deepEqual(a, b);
    assert.equal(a.result.sessionId, 'new-id');
    assert.deepEqual(f.writes.map(w => w[0]), ['create', 'prompt']);
    assert.equal(f.writes[1][2], 'new-id');
  } finally { f.bridge.dispose(); }
});

test('create rejects private paths, model overrides and permission-mode upgrades before writes', async () => {
  const f = setup();
  try {
    await assert.rejects(f.bridge.command(envelope({ workspaceId: '/private' })), /mismatch/);
    for (const [i, payload] of [{ config: { mode: 'yolo' } }, { config: { provider: 'private', model: 'secret' } }, { mcpServers: [] }, { config: { modelSelection: selection, provider: 'different' } }].entries()) {
      assert.equal((await f.bridge.command(envelope(payload, `bad-${i}`))).status, 'rejected');
    }
    assert.equal(f.writes.length, 0);
  } finally { f.bridge.dispose(); }
});

test('switchModelConfig enforces the observed epoch/revision and changes the real selection', async () => {
  const f = setup();
  const conversation = new Conversation({ sessionId: 'new-id', running: false }, f.bridge.epoch, catalog);
  f.bridge.subs.set('sub', { id: 'sub', topic: 'conversation/new-id', event: 'onDynamicConversationFrame', ordinal: 0, controller: new AbortController(), conversation });
  const command = { commandId: 'switch', clientId: 'mobile', sessionId: 'new-id', type: 'switchModelConfig', payload: { provider: 'provider', model: 'model', thought: 'high' }, issuedAt: Date.now(), baseLogEpoch: f.bridge.epoch, baseRevision: 0 };
  try {
    assert.equal((await f.bridge.command({ ...command, commandId: 'stale', baseLogEpoch: 'old' })).status, 'stale');
    assert.equal(f.writes.length, 0);
    assert.equal((await f.bridge.command(command)).status, 'accepted');
    assert.equal(conversation.snapshot().config.thought, 'high');
    assert.equal(f.writes.length, 1);
  } finally { f.bridge.dispose(); }
});

test('DSH creation validates the model before creating a session and rejects writes after stop', async () => {
  let creates = 0;
  const ctx = { workspaceController: { async *follow() { yield { type: 'baseline', value: { items: [{ workspaceId: 'shared', path: '/shared', sessionIds: [] }] } }; } },
    sessionController: { modelCatalog: async () => catalog, create: async () => { creates++; return { sessionId: 'id' }; } } };
  const backend = new DshBackend(ctx, ['shared']);
  await assert.rejects(backend.create('/shared', { ...selection, modelId: 'private' }));
  backend.dispose(); await assert.rejects(backend.create('/shared'));
  assert.equal(creates, 0);
});
