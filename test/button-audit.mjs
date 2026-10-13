import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

export async function buttonAudit({ mobile, desktop, seed }) {
  for (let i = 0; i < 3; i++) { await mobile.keyboard.press('Escape'); await delay(300); }
  assert.equal(await mobile.getByRole('button', { name: '已停止', exact: true }).count(), 1);
  assert.equal(await mobile.getByRole('button', { name: /^已工作/ }).count(), 3);
  console.log('PASS_HISTORICAL_TURN_STATES');
  for (const name of ['选择主题', '更多', '展开侧边面板']) {
    await mobile.getByRole('button', { name, exact: true }).click();
    await delay(800);
    console.log(`AUDIT_MENU_${name}`, await mobile.locator('body').ariaSnapshot());
    await mobile.screenshot({ path: `test/audit-${name}.png`, fullPage: true });
    await mobile.keyboard.press('Escape');
    await delay(400);
  }
  // The mobile close button is the backdrop; its center is covered by the panel.
  await mobile.getByRole('button', { name: '收起侧边面板', exact: true }).click({ position: { x: 10, y: 100 } });
  await delay(400);
  for (const label of ['浅色主题', '系统默认', '深色主题']) {
    await mobile.getByRole('button', { name: '选择主题', exact: true }).click();
    await mobile.getByRole('menuitemradio', { name: label, exact: true }).click();
    await delay(400);
    await mobile.getByRole('button', { name: '选择主题', exact: true }).click();
    assert.equal(await mobile.getByRole('menuitemradio', { name: label, exact: true }).getAttribute('aria-checked'), 'true');
    await mobile.keyboard.press('Escape'); await delay(400);
  }
  console.log('PASS_THREE_THEMES');
  await mobile.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://zcode.z.ai' });
  await mobile.getByRole('button', { name: '复制', exact: true }).last().click();
  assert.match(await mobile.evaluate(() => navigator.clipboard.readText()), /DSH real Host continued after stop/);
  await mobile.getByRole('button', { name: '更多', exact: true }).click();
  await mobile.getByRole('menuitem', { name: '复制会话 ID', exact: true }).click();
  assert.equal(await mobile.evaluate(() => navigator.clipboard.readText()), seed.sessionId);
  console.log('PASS_COPY_REPLY_AND_SESSION_ID');
  await delay(400);
  const openRename = async () => {
    await mobile.getByRole('button', { name: '更多', exact: true }).click();
    await mobile.getByRole('menuitem', { name: '重命名任务', exact: true }).click();
    return mobile.getByRole('dialog', { name: '重命名任务', exact: true });
  };
  let dialog = await openRename();
  await dialog.getByRole('textbox').fill('NTR cancelled rename');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await mobile.getByRole('heading', { name: 'NTR newly created session', exact: true }).waitFor();
  await delay(400);
  dialog = await openRename();
  await dialog.getByRole('textbox').fill('NTR audited mobile rename');
  await dialog.getByRole('button', { name: '确认', exact: true }).click();
  await mobile.getByRole('heading', { name: 'NTR audited mobile rename', exact: true }).waitFor({ timeout: 10000 });
  const directory = await desktop.evaluate(async () => (await fetch('/api/plugins/ntr-test/directory')).json());
  assert.equal(directory.sessions.find(s => s.sessionId === seed.sessionId).projections.values.title, 'NTR audited mobile rename');
  console.log('PASS_RENAME_CANCEL_AND_SAVE');
  await mobile.screenshot({ path: 'test/audit-buttons-mobile.png', fullPage: true });
  assert(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  console.log('PASS_MOBILE_DOCUMENT_WIDTH');
}
