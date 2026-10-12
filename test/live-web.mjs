// Explicit opt-in integration probe. Only synthetic fixtures leave this process.
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { Relay } from '../lib/relay.js';
import { RemoteHost } from '../lib/bridge.js';
if (!process.argv.includes('--live')) throw new Error('Pass --live for the official relay/page probe');
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const workspace = { workspaceId: 'dsh-compat-test', path: 'D:/DSH-compatibility-test', title: 'DSH compatibility test', sessionIds: ['dsh-test-session'] };
const summary = { sessionId: 'dsh-test-session', updatedAt: Date.now(), running: false, projections: { values: { title: 'DSH adapter synthetic session' } } };
const records = [{ type: 'event', event: { type: 'user/message', surfaceOp: 'append', seq: 1, time: Date.now(),
  data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Synthetic hello from DSH adapter' }] } } },
{ type: 'event', event: { type: 'assistant/message', surfaceOp: 'append', seq: 2, time: Date.now(),
  data: { message: { content: [{ type: 'text', text: 'Synthetic reply for protocol verification only.' }] } } } }];
let notify;
const backend = {
  workspaces: async () => [workspace],
  workspace: async path => { if (path !== workspace.path) throw new Error('Scope'); return workspace; },
  sessions: async path => { await backend.workspace(path); return [summary]; },
  session: async (path, id) => { await backend.workspace(path); if (id !== summary.sessionId) throw new Error('Scope'); return summary; },
  async *follow(path, id, signal) {
    await backend.session(path, id);
    yield { type: 'snapshot', records: [...records], hasMore: false, projections: summary.projections };
    while (!signal.aborted) {
      await Promise.race([new Promise(r => { notify = r; }), delay(1000)]);
      if (!signal.aborted) yield { type: 'snapshot', records: [...records], hasMore: false, projections: summary.projections };
    }
  },
  prompt: async (_path, _id, commandId, text) => {
    console.log('FIXTURE_PROMPT_ACCEPTED');
    records.push({ type: 'event', event: { type: 'user/message', surfaceOp: 'append', seq: records.length + 1, time: Date.now(), data: { source: { kind: 'user', rpcId: commandId }, content: [{ type: 'text', text }] } } });
    records.push({ type: 'event', event: { type: 'assistant/message', surfaceOp: 'append', seq: records.length + 1, time: Date.now(), data: { message: { content: [{ type: 'text', text: 'DSH fixture received your remote message.' }] } } } });
    notify?.();
  },
  cancel: async () => {},
};
const calls = new Set();
const relay = new Relay({ onPayload: p => { if (p?.zcode_type === 'mobile-diagnostic') console.log('DIAGNOSTIC', JSON.stringify(p)); return host.accept(p); }, onStatus: s => console.log('RELAY', s.state) });
const host = new RemoteHost(backend, p => relay.payload(p), (name, args) => { if (!calls.has(name)) { calls.add(name); console.log('RPC', name); } if (name.endsWith('.sendConversationCommandV4')) console.log('FIXTURE_COMMAND', JSON.stringify(args)); });
let browser;
try {
  await relay.start();
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', e => console.log('PAGE_ERROR', e.message.replace(/https?:\S+/g, '[url]')));
  page.on('console', m => { if (['error', 'warning'].includes(m.type())) console.log('CONSOLE', m.text().replace(/https?:\S+/g, '[url]')); });
  await page.goto(relay.link(), { waitUntil: 'domcontentloaded', timeout: 40000 });
  await delay(18000);
  const close = page.getByRole('button', { name: 'Close', exact: true });
  if (await close.isVisible()) await close.click();
  if (process.argv.includes('--home')) {
    console.log('HOME', (await page.locator('body').innerText()).slice(0, 6000));
    console.log('BUTTONS', await page.getByRole('button').evaluateAll(nodes => nodes.map(n => ({ text: n.textContent, label: n.getAttribute('aria-label'), title: n.getAttribute('title') }))));
    await page.screenshot({ path: 'test/home-probe.png', fullPage: true });
    await page.getByRole('button').nth(5).click();
    await delay(3000);
    console.log('DRAFT', (await page.locator('body').innerText()).slice(0, 6000));
    const editor = page.locator('[contenteditable=true]').first();
    if (await editor.isVisible()) {
      await editor.fill('New remote session probe');
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await delay(5000);
      console.log('HOME_SEND', (await page.locator('body').innerText()).slice(0, 6000));
      const details = page.getByRole('button', { name: '展开详情', exact: true });
      if (await details.isVisible()) { await details.click(); console.log('DETAIL', (await page.locator('body').innerText()).slice(0, 6000)); }
    }
  } else {
  await page.getByText('DSH adapter synthetic session', { exact: true }).first().click({ timeout: 5000 });
  await delay(10000);
  console.log('INPUTS', await page.locator('textarea,input,[contenteditable=true]').evaluateAll(nodes => nodes.map(n => ({ tag: n.tagName, placeholder: n.getAttribute('placeholder'), role: n.getAttribute('role') }))));
  const editor = page.locator('[contenteditable=true]').first();
  await editor.fill('Remote adapter roundtrip test', { timeout: 5000 });
  await page.getByRole('button', { name: '发送', exact: true }).click({ timeout: 5000 });
  await delay(7000);
  assert(await page.getByText('DSH fixture received your remote message.', { exact: true }).isVisible(), 'Remote reply must render');
  console.log('BODY', (await page.locator('body').innerText()).slice(0, 9000));
  await page.screenshot({ path: 'test/live-web.png', fullPage: true });
  }
} finally {
  await browser?.close();
  host.dispose();
  relay.stop();
}
