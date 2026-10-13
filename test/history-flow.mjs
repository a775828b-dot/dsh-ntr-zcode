import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

export async function historyFlow({ desktop, mobile }) {
  await mobile.getByRole('button', { name: '停止生成', exact: true }).waitFor({ state: 'hidden', timeout: 15000 });
  const seed = await desktop.evaluate(async () => (await fetch('/api/plugins/ntr-test/long-history', { method: 'POST' })).json());
  assert(seed.sessionId);
  await mobile.getByRole('button', { name: '返回任务首页', exact: true }).click();
  await mobile.getByRole('button', { name: /^NTR Long History/ }).click({ timeout: 15000 });
  await mobile.getByText('NTR history marker 229', { exact: true }).waitFor({ timeout: 15000 });
  await mobile.getByRole('main').hover();
  for (let i = 0; i < 20; i++) {
    await mobile.mouse.wheel(0, -20000);
    await delay(600);
    if (await mobile.getByText('NTR history marker 000', { exact: true }).isVisible()) break;
  }
  await mobile.getByText('NTR history marker 000', { exact: true }).waitFor({ timeout: 15000 });
  console.log('PASS_HISTORY_230_REAL_MESSAGES');
  await mobile.screenshot({ path: 'test/history-mobile.png', fullPage: true });
  await mobile.locator('[contenteditable=true]').first().fill('/compact');
  await mobile.getByRole('button', { name: '发送', exact: true }).click();
  let result;
  for (let i = 0; i < 30; i++) {
    await delay(1000);
    result = await desktop.evaluate(async id => (await fetch(`/api/plugins/ntr-test/history?sessionId=${encodeURIComponent(id)}`)).json(), seed.sessionId);
    if (result.first.value.records.some(r => r.event?.type === 'user/message' && r.event.data.source.kind === 'compact-checkpoint')) break;
  }
  assert(result.first.value.records.some(r => r.event?.type === 'user/message' && r.event.data.source.kind === 'compact-checkpoint'));
  console.log('PASS_COMPACTION_DURABLE_CHECKPOINT');
  console.log('COMPACT_UI', await mobile.locator('body').ariaSnapshot());
}
