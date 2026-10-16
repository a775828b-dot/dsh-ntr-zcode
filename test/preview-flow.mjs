import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

export async function previewFlow({ desktop, mobile, seed }) {
  await mobile.getByRole('button', { name: '停止生成', exact: true }).waitFor({ state: 'hidden', timeout: 15000 });
  const image = await desktop.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 200;
    const context = canvas.getContext('2d');
    context.fillStyle = '#147d64'; context.fillRect(0, 0, 160, 200);
    context.fillStyle = '#d54e63'; context.fillRect(160, 0, 160, 200);
    context.fillStyle = 'white'; context.font = '24px sans-serif'; context.fillText('DSH output preview', 40, 100);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  const result = await desktop.evaluate(async ({ sessionId, image }) => {
    const response = await fetch('/api/plugins/ntr-test/previews', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, image }) });
    if (!response.ok) throw new Error(`Preview seed failed: ${response.status} ${await response.text()}`);
    return response.json();
  }, { sessionId: seed.sessionId, image });
  assert(result.ok);
  assert.equal(result.allowed, 'NTR scoped workspace file preview');
  assert.deepEqual(result.denied, ['./unlinked.txt', './.env', './escape-preview/outside.txt', '../private-preview-fixture/outside.txt']);
  console.log('PASS_REAL_HOST_UNLINKED_HIDDEN_TRAVERSAL_JUNCTION_DENIAL');
  for (const reload of [false, true]) {
    if (reload) await mobile.reload({ waitUntil: 'domcontentloaded' });
    await mobile.getByText('NTR generated assistant image', { exact: true }).waitFor({ timeout: 25000 });
    for (const name of ['desktop-input.png', 'assistant-output.png', 'tool-output.png', 'local-output']) {
      const img = mobile.getByRole('img', { name, exact: true });
      await img.scrollIntoViewIfNeeded();
      await mobile.waitForFunction(name => [...document.querySelectorAll('img')].some(i => i.alt === name && i.complete && i.naturalWidth > 0), name, { timeout: 15000 });
      await img.click();
      await mobile.getByRole('dialog').waitFor();
      assert(await mobile.getByRole('dialog').locator('img').evaluateAll(images => images.some(i => i.complete && i.naturalWidth > 0)));
      await mobile.keyboard.press('Escape');
      await mobile.getByRole('dialog').waitFor({ state: 'hidden' });
    }
    console.log('PASS_OUTPUT_IMAGES_AND_LOCAL_FILE', reload ? 'reload' : 'live');
  }
  await mobile.getByText('Open result.txt', { exact: true }).click();
  await delay(1500);
  console.log('PREVIEW_FILE_UI', await mobile.locator('body').ariaSnapshot());
  await mobile.getByText('NTR scoped workspace file preview', { exact: false }).first().waitFor({ timeout: 12000 });
  console.log('PASS_LINKED_TEXT_FILE_PREVIEW');
  await mobile.screenshot({ path: 'test/output-file-preview.png', fullPage: true });
  await mobile.getByRole('button', { name: '收起侧边面板', exact: true }).click({ position: { x: 10, y: 100 } });
  await mobile.getByText('DSH file: history-note.txt', { exact: true }).click();
  await mobile.getByText('NTR historical text attachment preview', { exact: false }).first().waitFor({ timeout: 12000 });
  console.log('PASS_HISTORY_FILE_PREVIEW');
  await mobile.getByRole('button', { name: '收起侧边面板', exact: true }).click({ position: { x: 10, y: 100 } });
  await mobile.getByText('DSH file: generated report).txt', { exact: true }).click();
  await mobile.getByText('NTR tool file output preview', { exact: false }).first().waitFor({ timeout: 12000 });
  console.log('PASS_TOOL_OUTPUT_FILE_PREVIEW_SPECIAL_FILENAME');
  await mobile.getByRole('button', { name: '收起侧边面板', exact: true }).click({ position: { x: 10, y: 100 } });
  await mobile.setViewportSize({ width: 1280, height: 900 });
  await delay(1500);
  await mobile.getByRole('img', { name: 'assistant-output.png', exact: true }).scrollIntoViewIfNeeded();
  await mobile.screenshot({ path: 'test/output-images-desktop.png', fullPage: true });
  await mobile.setViewportSize({ width: 390, height: 844 });
  await delay(1500);
  await mobile.getByRole('img', { name: 'assistant-output.png', exact: true }).scrollIntoViewIfNeeded();
  await mobile.waitForFunction(() => [...document.querySelectorAll('img')].some(i => i.alt === 'assistant-output.png' && i.complete && i.naturalWidth === 320));
  await mobile.screenshot({ path: 'test/output-images-mobile.png', fullPage: true });
}
