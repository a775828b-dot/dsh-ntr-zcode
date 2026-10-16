import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
if (!process.argv.includes('--live')) throw new Error('Pass --live to test the official page and relay with an isolated DSH Host');
const flows = process.argv.includes('--flows');
const extended = process.argv.includes('--extended');
const features = process.argv.includes('--features');
const longHistory = process.argv.includes('--history');
const queueFlow = process.argv.includes('--queue');
const crossModels = features || process.argv.includes('--models');
const source = resolve(process.env.DSH_SOURCE || '../../source');
const sourceVersion = JSON.parse(await readFile(join(source, 'apps/cli/package.json'), 'utf8')).version;
const builtVersion = execFileSync(process.execPath, [join(source, 'apps/cli/lib/bin.js'), '--version'],
  { cwd: source, encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim();
assert.equal(builtVersion, sourceVersion, 'DSH CLI and source manifest versions must agree');
const { readClientBuildRecord } = await import(pathToFileURL(join(source, 'scripts/client-build-environment.ts')).href);
const buildRecord = readClientBuildRecord(source);
assert.equal(buildRecord.environment.DSH_CLIENT_VERSION, sourceVersion, 'Rebuild the DSH client after switching versions');
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8', windowsHide: true }).trim();
assert.equal(buildRecord.environment.DSH_CLIENT_COMMIT_HASH, sourceCommit.slice(0, 7), 'Rebuild the DSH client after switching commits');
if (process.env.DSH_EXPECT_VERSION) assert.equal(builtVersion, process.env.DSH_EXPECT_VERSION, 'Unexpected DSH test version');
console.log('DSH_TEST_VERSION', builtVersion, sourceCommit);
const home = await mkdtemp(resolve('test/isolated-'));
const workspace = join(home, 'workspace');
await mkdir(workspace);
if (flows) await mkdir(join(home, 'second-project'));
const slash = path => path.replaceAll('\\', '/');
const textStream = text => ({ kind: 'chunks', chunks: [
  { type: 'block-start', index: 0, blockType: 'text' },
  ...text.split(' ').map(word => ({ type: 'text-delta', index: 0, text: `${word} ` })),
  { type: 'block-end', index: 0, block: { type: 'text', text: `${text} ` } },
  { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } },
  { type: 'finish', reason: { kind: 'stop' } },
] });
const todoArgs = JSON.stringify({ todos: [{ content: 'NTR inspect bridge', status: 'completed' }, { content: 'NTR verify mobile', status: 'in_progress' }] });
const toolStream = { kind: 'chunks', chunks: [
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 0, id: 'ntr-todo', name: 'todo_write', argumentsDelta: todoArgs },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'ntr-todo', name: 'todo_write', arguments: todoArgs } },
  { type: 'finish', reason: { kind: 'tool-calls' } },
] };
await writeFile(join(home, 'replay.json'), JSON.stringify([
  textStream('DSH real Host initial reply.'), textStream('DSH real Host received the mobile message.'),
  ...(longHistory ? [textStream('NTR compacted history: synthetic numbered messages were reviewed; no external actions were performed.')]
    : features ? [textStream('DSH permission step 1.'), textStream('DSH permission step 2.'), textStream('DSH image-only reply.')]
      : [{ kind: 'hang' }, textStream('DSH real Host continued after stop.')]),
  ...(extended ? [...(features ? [{ kind: 'hang' }, textStream('Extended file received.')] : []), toolStream,
    textStream('NTR plan and tool completed.'), { kind: 'hang' }, { kind: 'hang' }] : []),
  ...(queueFlow ? [{ kind: 'hang' }, textStream('Queue promoted B.'), textStream('Queue drained C.'), textStream('Queue drained A.'),
    textStream(`Queue slow current ${'waiting '.repeat(80)}complete.`), textStream('Queue resumed D.'), textStream('Queue resumed E.'),
    { kind: 'hang' }, textStream('Queue immediate F.'), textStream('Queue after F G.')] : []),
]));
await writeFile(join(home, 'overlay.yml'), `
- id: llm-deepseek
  disabled: true
- id: llm-deepseek-account
  disabled: true
- id: session-title-llm
  disabled: true
- id: agent-instructions
  disabled: true
- id: agent-default-model
  config:
    provider: ${crossModels ? 'home' : 'deepseek-official'}
    model: ${crossModels ? 'GLM-5.3-Flash-NVFP4' : 'deepseek-flash'}
- insert:
  - id: ntr-replay
    name: '${slash(join(source, 'packages/test-support/llm-replay/lib/index.js'))}'
    config:
      file: '${slash(join(home, 'override-only.jsonl'))}'
      overrideFile: '${slash(join(home, 'replay.json'))}'
      paceMs: 60
      providers:
        - id: home
          models:
            - id: GLM-5.3-Flash-NVFP4
              contextWindow: 128000
              reasoningEfforts: [max]
              defaultReasoningEffort: max
            - id: DeepSeek-V4.1-Flash
              contextWindow: 128000
              reasoningEfforts: [low, xhigh, max]
              defaultReasoningEffort: max
        - id: deepseek-official
          models:
            - id: deepseek-flash
              contextWindow: 128000
              reasoningEfforts: [low, medium, high]
              defaultReasoningEffort: medium
            - id: deepseek-pro
              contextWindow: 128000
              reasoningEfforts: [low, medium, high]
              defaultReasoningEffort: medium
        - id: deepseek-account
          models:
            - id: deepseek-flash
              contextWindow: 128000
              reasoningEfforts: [high, max]
              defaultReasoningEffort: high
  - id: dsh-ntr-zcode
    name: '${slash(resolve('lib/index.js'))}'
  - id: ntr-test-fixture
    name: '${slash(resolve('test/host-fixture.js'))}'
`);
const env = { ...process.env, DSH_HOME: home, DSH_NTR_ISOLATED_TEST: '1', DSH_NTR_TEST_WORKSPACE: workspace, DSH_NTR_SOURCE: source, DSH_TELEMETRY: '0' };
delete env.DEEPSEEK_API_KEY;
const child = spawn(process.execPath, [join(source, 'apps/cli/lib/bin.js'), '--profile', 'web', '--patch', join(source, 'apps/web/tests/pin-browse-picker.overlay.yml'), '--patch', join(home, 'overlay.yml'), '--no-open', '--port', '0'], { cwd: workspace, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let logs = '';
child.stdout.on('data', b => { logs += b; });
child.stderr.on('data', b => { logs += b; });
const exited = new Promise(r => child.once('exit', r));
let browser, mobile, imageBytes;
try {
  let ready;
  for (let i = 0; i < 100; i++) {
    try { ready = JSON.parse(await readFile(join(home, 'test-ready.json'), 'utf8')); break; } catch {}
    if (child.exitCode !== null) throw new Error(`DSH boot exited ${child.exitCode}`);
    await delay(500);
  }
  if (!ready) throw new Error('DSH boot timed out');
  console.log('DSH_PROFILE_READY');
  const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const context = await browser.newContext();
  const desktop = await context.newPage();
  await desktop.goto(ready.url, { waitUntil: 'domcontentloaded', timeout: 40000 });
  await delay(2500);
  const seed = await desktop.evaluate(async flows => { const r = await fetch(`/api/plugins/ntr-test/seed${flows ? '?blank=1' : ''}`, { method: 'POST' }); if (!r.ok) throw new Error(`seed ${r.status}`); return r.json(); }, flows);
  await delay(4000);
  const seedHistory = await desktop.evaluate(async seed => (await fetch(`/api/plugins/ntr-test/history?sessionId=${encodeURIComponent(seed.sessionId)}`)).json(), seed);
  console.log('DSH_SEED_RESULT', seedHistory.first?.value?.records?.filter(r => r.event?.type === 'turn/end').map(r => r.event.data.reason));
  const welcome = desktop.getByRole('button', { name: /继续|Continue/, exact: true });
  if (await welcome.first().isVisible()) await welcome.first().click();
  await desktop.getByRole('button', { name: /^(设置|Settings)$/ }).click({ timeout: 10000 });
  await desktop.getByRole('button', { name: 'Dsh ntr Zcode', exact: true }).click({ timeout: 10000 });
  if (process.argv.includes('--audit')) {
    const pattern = '**/api/plugins/dsh-ntr-zcode/remote';
    await desktop.route(pattern, route => route.request().method() === 'GET'
      ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'NTR simulated offline' }) }) : route.continue());
    await desktop.getByRole('alert').filter({ hasText: 'NTR simulated offline' }).waitFor({ timeout: 7000 });
    await desktop.unroute(pattern);
    await desktop.getByRole('alert').filter({ hasText: 'NTR simulated offline' }).waitFor({ state: 'hidden', timeout: 7000 });
    console.log('PASS_SETTINGS_ERROR_RECOVERY');
  }
  // Select by returned workspace identity rather than relying on list order.
  const wsLabel = desktop.locator('.ntr fieldset label').filter({ hasText: workspace });
  for (const checked of await desktop.locator('.ntr fieldset input:checked').all()) await checked.uncheck();
  await wsLabel.locator('input').check();
  if (flows) await desktop.locator('.ntr fieldset label').filter({ hasText: 'second-project' }).locator('input').check();
  await desktop.getByLabel('允许手机通过官方中继访问所选工作区').check();
  await desktop.getByLabel('允许手机切换 DSH 权限（含完全权限）').check();
  if (extended) await desktop.getByLabel('允许手机接管新审批和问答（断开或超时后交回桌面）').check();
  await desktop.getByRole('button', { name: '开启远程', exact: true }).click();
  await desktop.locator('.ntr-qr').waitFor({ timeout: 25000 });
  const control = await desktop.evaluate(async () => (await fetch('/api/plugins/dsh-ntr-zcode/remote')).json());
  assert(control.link && control.qr);
  mobile = await context.newPage({ viewport: { width: 390, height: 844 } });
  const pageErrors = [];
  mobile.on('pageerror', e => { pageErrors.push(e.message); console.log('PAGE_ERROR', e.message.replace(/https?:\S+/g, '[url]')); });
  mobile.on('requestfailed', r => console.log('REQUEST_FAILED', new URL(r.url()).protocol, r.resourceType(), r.failure()?.errorText));
  mobile.on('console', m => { if (['error', 'warning'].includes(m.type())) console.log('BROWSER_DIAGNOSTIC', m.text().replace(/https?:\S+/g, '[url]').slice(0, 1000)); });
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto(control.link, { waitUntil: 'domcontentloaded', timeout: 40000 });
  if (flows) {
    await mobile.getByRole('button', { name: '刷新工作区和任务', exact: true }).waitFor({ timeout: 25000 });
    await mobile.getByRole('button').filter({ has: mobile.locator('svg.lucide-plus') }).first().click();
    await mobile.locator('[contenteditable=true]').first().waitFor({ timeout: 15000 });
    await delay(2500);
    const draftDirectory = await desktop.evaluate(async () => (await fetch('/api/plugins/ntr-test/directory')).json());
    const abandonedDraft = draftDirectory.sessions.find(s => s.sessionId !== seed.sessionId && s.blank === true)?.sessionId;
    assert(abandonedDraft, 'Opening a draft should prewarm a real isolated DSH session');
    await mobile.getByRole('button', { name: '选择项目', exact: true }).click();
    console.log('PROJECTS', await mobile.locator('body').ariaSnapshot());
    await mobile.keyboard.press('Escape');
    // The original inline picker is scoped to the current bridge. Cross-project
    // navigation belongs to the original mobile home, not this local tab menu.
    await mobile.getByRole('button', { name: '返回任务首页', exact: true }).click();
    let cleanedDraft;
    for (let i = 0; i < 20; i++) {
      cleanedDraft = await desktop.evaluate(async () => (await fetch('/api/plugins/ntr-test/directory')).json());
      if (cleanedDraft.membership.value.archivedSessionIds.includes(abandonedDraft)) break;
      await delay(300);
    }
    assert(cleanedDraft.membership.value.archivedSessionIds.includes(abandonedDraft), 'Abandoned remote draft must be recoverably archived');
    assert(cleanedDraft.sessions.some(s => s.sessionId === abandonedDraft), 'Cleanup must not delete the session');
    assert(!cleanedDraft.membership.value.archivedSessionIds.includes(seed.sessionId), 'Do not archive a pre-existing empty session');
    console.log('PASS_ABANDONED_DRAFT_RECOVERABLE_CLEANUP');
    await mobile.getByRole('button', { name: /^second-project/ }).locator('..').getByRole('button').filter({ has: mobile.locator('svg.lucide-plus') }).click();
    await mobile.getByRole('button', { name: '选择项目', exact: true }).filter({ hasText: 'second-project' }).waitFor({ timeout: 10000 });
    await mobile.getByRole('button', { name: '返回任务首页', exact: true }).click();
    await mobile.getByRole('button', { name: /^workspace\b/ }).locator('..').getByRole('button').filter({ has: mobile.locator('svg.lucide-plus') }).click();
    await mobile.getByRole('button', { name: '选择项目', exact: true }).filter({ hasText: 'workspace' }).waitFor({ timeout: 10000 });
    console.log('PASS_PROJECT_SWITCH');
    console.log('DRAFT_BODY', (await mobile.locator('body').innerText()).slice(0, 4000));
    console.log('DRAFT_BUTTONS', await mobile.getByRole('button').evaluateAll(nodes => nodes.map(n => ({ text: n.textContent, label: n.getAttribute('aria-label'), title: n.getAttribute('title') }))));
    await mobile.screenshot({ path: 'test/flows-draft.png', fullPage: true });
    await mobile.getByRole('button', { name: '选择模型', exact: true }).click();
    console.log('MODELS', await mobile.locator('body').ariaSnapshot());
    await mobile.screenshot({ path: 'test/flows-models.png', fullPage: true });
    await mobile.getByRole('menuitem', { name: 'deepseek-official', exact: true }).click();
    await mobile.getByText('deepseek-pro', { exact: true }).last().click({ timeout: 5000 });
    await delay(1500);
    console.log('AFTER_MODEL', await mobile.locator('body').ariaSnapshot());
    if (!crossModels) {
      await mobile.getByRole('combobox').click();
      await mobile.getByRole('option', { name: '高', exact: true }).click();
    }
    await mobile.locator('[contenteditable=true]').first().fill('NTR newly created session');
    await mobile.getByRole('button', { name: '发送', exact: true }).click();
    await mobile.getByText('DSH real Host initial reply.', { exact: true }).waitFor({ timeout: 20000 });
    const remote = await desktop.evaluate(async () => (await fetch('/api/plugins/dsh-ntr-zcode/remote')).json());
    assert(remote.workspaces.find(w => w.id === seed.workspaceId).sessions > 1);
    console.log('PASS_NEW_SESSION');
    // Resolve the newly created ID from the read-only isolated fixture directory.
    const directory = await desktop.evaluate(async () => (await fetch('/api/plugins/ntr-test/directory')).json());
    seed.sessionId = directory.sessions.find(s => s.sessionId !== seed.sessionId && s.projections?.values?.sessionListMetadata?.blank === false)?.sessionId;
    assert(seed.sessionId);
  } else {
  await mobile.getByText('NTR DSH real host test', { exact: true }).first().click({ timeout: 25000 });
  await mobile.getByText('DSH real Host initial reply.', { exact: true }).waitFor({ timeout: 20000 });
  if (crossModels) {
    await mobile.getByRole('button', { name: '选择模型', exact: true }).click();
    await mobile.getByRole('menuitem', { name: features ? 'deepseek-account' : 'home', exact: true }).click();
    await mobile.getByText(features ? 'deepseek-flash' : 'DeepSeek-V4.1-Flash', { exact: true }).last().click();
    await delay(1000);
    console.log('CROSS_MODEL_UI', await mobile.locator('body').ariaSnapshot());
  }
  }
  await delay(1000);
  if (features) {
    await mobile.getByRole('button', { name: '切换模式', exact: true }).click();
    await mobile.getByRole('menuitemradio', { name: /^完全访问/ }).click();
    const png = Buffer.from(await mobile.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#e63650'; ctx.fillRect(0, 0, 32, 64);
      ctx.fillStyle = '#18a4cc'; ctx.fillRect(32, 0, 32, 64);
      return canvas.toDataURL('image/png').split(',')[1];
    }), 'base64');
    imageBytes = png;
    await mobile.locator('input[type=file]').first().setInputFiles({ name: 'ntr-test.png', mimeType: 'image/png', buffer: png });
    await delay(3500);
    console.log('IMAGE_UPLOAD_UI', await mobile.locator('body').ariaSnapshot());
    await mobile.getByRole('button', { name: '移除附件', exact: true }).click();
    await mobile.getByRole('button', { name: '移除附件', exact: true }).waitFor({ state: 'hidden' });
    assert(await mobile.getByRole('button', { name: '发送', exact: true }).isDisabled());
    await mobile.locator('input[type=file]').first().setInputFiles({ name: 'ntr-test.png', mimeType: 'image/png', buffer: png });
    await mobile.getByRole('button', { name: '打开图片预览', exact: true }).click();
    console.log('IMAGE_LIGHTBOX_UI', await mobile.locator('body').ariaSnapshot());
    const preview = mobile.getByRole('dialog', { name: 'ntr-test.png', exact: true });
    await preview.getByRole('button', { name: '放大', exact: true }).click();
    assert.notEqual(await preview.getByText(/^\d+%$/).innerText(), '100%');
    await preview.getByRole('button', { name: '缩小', exact: true }).click();
    assert.equal(await preview.getByText(/^\d+%$/).innerText(), '100%');
    const downloaded = mobile.waitForEvent('download');
    await preview.getByRole('button', { name: '下载图片', exact: true }).click();
    const download = await downloaded;
    assert.equal(download.suggestedFilename(), 'ntr-test.png');
    const bytes = [];
    for await (const chunk of await download.createReadStream()) bytes.push(chunk);
    assert.deepEqual(Buffer.concat(bytes), png);
    await preview.getByRole('button', { name: '关闭', exact: true }).click();
    await preview.waitFor({ state: 'hidden' }); await delay(500);
    console.log('PASS_IMAGE_ZOOM_DOWNLOAD_CLOSE');
    console.log('PASS_ATTACHMENT_REMOVE_READD_PREVIEW');
  }
  await mobile.locator('[contenteditable=true]').first().fill('Mobile to real DSH Host test');
  await mobile.getByRole('button', { name: '发送', exact: true }).click({ timeout: 5000 });
  await mobile.getByText('DSH real Host received the mobile message.', { exact: true }).waitFor({ timeout: 20000 });
  const history = await desktop.evaluate(async seed => {
    const response = await fetch(`/api/plugins/ntr-test/history?sessionId=${encodeURIComponent(seed.sessionId)}`);
    const body = await response.text();
    if (!response.ok || !body) throw new Error(`History response ${response.status}: ${body.slice(0, 200)}`);
    return JSON.parse(body);
  }, seed);
  assert(JSON.stringify(history).includes('Mobile to real DSH Host test'));
  assert(JSON.stringify(history).includes('DSH real Host received the mobile message.'));
  if (features) {
    const projection = history.first.value.projections.values;
    assert.equal(projection.modelSelection.next.provider, 'deepseek-account');
    assert.equal(projection.permissions.currentValue, 'danger-full-access');
    const input = history.first.value.records.find(r => r.event?.type === 'user/message' && r.event.data.content?.some(b => b.type === 'image'));
    assert(input?.event.data.content.some(b => b.attachment?.attachmentId));
    console.log('PASS_ACCOUNT_MODEL_FULL_ACCESS_IMAGE_DURABLE');
    await mobile.reload({ waitUntil: 'domcontentloaded' });
    await mobile.getByText('DSH real Host received the mobile message.', { exact: true }).waitFor({ timeout: 20000 });
    const picture = mobile.locator('img').filter({ hasNot: mobile.locator('[aria-hidden=true]') });
    await mobile.waitForFunction(() => [...document.querySelectorAll('main img')].some(img => img.complete && img.naturalWidth > 0), { timeout: 15000 });
    console.log('PASS_IMAGE_PREVIEW_AFTER_RELOAD', await picture.count());
    await mobile.locator('main img').first().scrollIntoViewIfNeeded();
    await mobile.screenshot({ path: 'test/image-preview-mobile.png', fullPage: true });
    for (const [index, [label, preset]] of [['变更前确认', 'read-only'], ['自动编辑', 'workspace-write']].entries()) {
      await mobile.getByRole('button', { name: '停止生成', exact: true }).waitFor({ state: 'hidden', timeout: 15000 });
      await mobile.getByRole('button', { name: '切换模式', exact: true }).click();
      await mobile.getByRole('menuitemradio', { name: new RegExp(`^${label}`) }).click();
      await mobile.locator('[contenteditable=true]').first().fill(`NTR permissions ${index + 1}`);
      await mobile.getByRole('button', { name: '发送', exact: true }).click();
      await mobile.getByText(`DSH permission step ${index + 1}.`, { exact: true }).waitFor({ timeout: 20000 });
      const current = await desktop.evaluate(async id => (await fetch(`/api/plugins/ntr-test/history?sessionId=${encodeURIComponent(id)}`)).json(), seed.sessionId);
      assert.equal(current.first.value.projections.values.permissions.currentValue, preset);
      console.log('PASS_PERMISSION_MAPPING', preset);
    }
    await mobile.getByRole('button', { name: '停止生成', exact: true }).waitFor({ state: 'hidden', timeout: 15000 });
    await mobile.locator('input[type=file]').first().setInputFiles({ name: 'image-only.png', mimeType: 'image/png', buffer: imageBytes });
    await mobile.getByRole('button', { name: '发送', exact: true }).click({ timeout: 15000 });
    await mobile.getByText('DSH image-only reply.', { exact: true }).waitFor({ timeout: 20000 });
    console.log('PASS_IMAGE_ONLY');
  }
  if (flows) {
    const selected = history.first.value.projections.values.modelSelection.next;
    assert.equal(selected.model, 'deepseek-pro'); assert.equal(selected.reasoningEffort, 'high');
    console.log('PASS_MODEL_AND_REASONING');
    await mobile.getByRole('button', { name: '停止生成', exact: true }).waitFor({ state: 'hidden', timeout: 15000 });
    await mobile.getByRole('button', { name: '选择模型', exact: true }).click();
    await mobile.getByRole('menuitem', { name: 'deepseek-official', exact: true }).click();
    await mobile.getByText('deepseek-flash', { exact: true }).last().click();
    await mobile.getByRole('combobox').click();
    await mobile.getByRole('option', { name: '低', exact: true }).click();
    // ZCode deliberately applies draft model/reasoning choices on submission.
    await mobile.locator('[contenteditable=true]').first().fill('NTR wait for cancellation');
    await mobile.getByRole('button', { name: '发送', exact: true }).click();
    await mobile.getByRole('button', { name: '停止生成', exact: true }).waitFor({ timeout: 15000 });
    await delay(1500);
    let changed;
    for (let i = 0; i < 15; i++) {
      changed = await desktop.evaluate(async id => (await fetch(`/api/plugins/ntr-test/history?sessionId=${encodeURIComponent(id)}`)).json(), seed.sessionId);
      if (changed.first?.value?.projections?.values?.modelSelection?.next?.reasoningEffort === 'low') break;
      await delay(300);
    }
    assert.equal(changed.first.value.projections.values.modelSelection.next.reasoningEffort, 'low');
    assert.equal(changed.first.value.projections.values.modelSelection.next.model, 'deepseek-flash');
    console.log('PASS_EXISTING_MODEL_AND_REASONING_CHANGE');
    await mobile.getByRole('button', { name: '停止生成', exact: true }).click({ timeout: 15000 });
    await mobile.getByRole('button', { name: '停止生成', exact: true }).waitFor({ state: 'hidden', timeout: 15000 });
    await mobile.locator('[contenteditable=true]').first().fill('NTR continue after cancellation');
    await mobile.getByRole('button', { name: '发送', exact: true }).click();
    await mobile.getByText('DSH real Host continued after stop.', { exact: true }).waitFor({ timeout: 20000 });
    await mobile.getByRole('button', { name: '停止生成', exact: true }).waitFor({ state: 'hidden', timeout: 15000 });
    console.log('PASS_STOP_AND_CONTINUE');
    await mobile.getByRole('button', { name: '返回任务首页', exact: true }).click();
    await mobile.getByRole('button', { name: '刷新工作区和任务', exact: true }).click();
    await mobile.getByText('NTR newly created session', { exact: true }).first().click({ timeout: 10000 });
    await mobile.getByText('DSH real Host continued after stop.', { exact: true }).waitFor({ timeout: 15000 });
    await mobile.reload({ waitUntil: 'domcontentloaded' });
    // Reload may restore the task or show the directory, both must preserve it.
    await delay(4000);
    const reply = mobile.getByText('DSH real Host continued after stop.', { exact: true });
    if (!await reply.isVisible()) await mobile.getByText('NTR newly created session', { exact: true }).first().click({ timeout: 15000 });
    await reply.waitFor({ timeout: 15000 });
    console.log('PASS_DIRECTORY_AND_RELOAD');
    await mobile.getByRole('button', { name: '添加上下文', exact: true }).click();
    console.log('CONTEXT_MENU', await mobile.locator('body').ariaSnapshot());
    await mobile.keyboard.press('Escape');
    await mobile.getByRole('button', { name: '切换模式', exact: true }).click();
    console.log('MODE_MENU', await mobile.locator('body').ariaSnapshot());
    await mobile.keyboard.press('Escape');
  }
  if (extended) await (await import('./extended-flow.mjs')).extendedFlow({ desktop, mobile, seed });
  if (queueFlow) await (await import('./queue-flow.mjs')).queueFlow({ desktop, mobile, seed, imageBytes });
  if (flows && process.argv.includes('--audit')) await (await import('./button-audit.mjs')).buttonAudit({ desktop, mobile, seed });
  if (longHistory) await (await import('./history-flow.mjs')).historyFlow({ desktop, mobile });
  if (process.argv.includes('--previews')) await (await import('./preview-flow.mjs')).previewFlow({ desktop, mobile, seed });
  await mobile.screenshot({ path: 'test/real-host-mobile.png', fullPage: true });
  await desktop.getByRole('button', { name: '复制链接', exact: true }).click();
  await desktop.getByRole('button', { name: '已复制', exact: true }).waitFor({ timeout: 5000 });
  await desktop.getByRole('button', { name: '刷新二维码', exact: true }).click();
  await delay(3000);
  const rotated = await desktop.evaluate(async () => (await fetch('/api/plugins/dsh-ntr-zcode/remote')).json());
  assert(new URL(rotated.link).searchParams.get('mid') !== new URL(control.link).searchParams.get('mid'));
  await desktop.getByRole('button', { name: '停止', exact: true }).click();
  await desktop.getByRole('button', { name: '开启远程', exact: true }).waitFor({ timeout: 5000 });
  await desktop.screenshot({ path: 'test/real-host-settings.png', fullPage: true });
  assert.deepEqual(pageErrors, [], 'Original page must not raise an uncaught JavaScript exception');
  console.log('PASS: original ZCode page -> official relay -> real DSH session/agent/persistence -> original page. Model output: deterministic replay, no live API call.');
  if (crossModels) console.log(logs.split('\n').filter(l => l.includes('NTR_TEST_COMMAND')).join('\n'));
} catch (error) {
  if (mobile && await mobile.getByRole('button', { name: '展开详情', exact: true }).isVisible()) await mobile.getByRole('button', { name: '展开详情', exact: true }).click();
  if (mobile) { console.log('MOBILE_BODY', (await mobile.locator('body').innerText()).slice(0, 5000)); await mobile.screenshot({ path: 'test/real-host-failure.png', fullPage: true }); }
  console.log(logs.replace(/https?:\S+/g, '[url]').slice(-12000));
  throw error;
} finally {
  await browser?.close();
  if (child.exitCode === null) {
    const kill = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    await new Promise(r => kill.once('exit', r));
  }
  await exited;
  // Pairing/login tokens in the isolated directory are not retained as artifacts.
  await writeFile(join(home, 'test-ready.json'), '{}');
}
