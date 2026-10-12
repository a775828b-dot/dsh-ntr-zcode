import { build } from 'esbuild';
import { resolve } from 'node:path';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const ref = resolve(process.env.ZCODE_SOURCE || '../../previews/zcode-reference');
const pinnedCommit = 'aac4755666d09fdcd70272fcf063c077a639015f';
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ref, encoding: 'utf8' }).trim();
if (sha !== pinnedCommit) throw new Error(`Expected ZCode ${pinnedCommit}, got ${sha}`);
const shared = resolve(ref, 'packages/shared/src');
await mkdir('lib', { recursive: true });
await mkdir('licenses', { recursive: true });
const result = await build({
  stdin: { contents: `
    export { ChannelServer, ChannelClient, Emitter } from '${ref.replaceAll('\\', '/')}/packages/rpc/src/index.ts';
    export { createAcknowledgedWebRemoteControlRelayProtocol } from '${ref.replaceAll('\\', '/')}/packages/client/src/webRemoteControlAcknowledgedRelayProtocol.ts';
    export { encodeTopicWireFrames } from '${shared.replaceAll('\\', '/')}/zcode-protocol-v4/wire-codec.ts';
    export { conversationSnapshotSchema } from '${shared.replaceAll('\\', '/')}/zcode-protocol-v4/snapshot.ts';
    export { parseCommandEnvelope, commandAckSchema } from '${shared.replaceAll('\\', '/')}/zcode-protocol-v4/command.ts';
    export { appSettingsSchema } from '${shared.replaceAll('\\', '/')}/validationAppSettings.ts';
    export { conversationTopicFrameSchema, sessionsIndexTopicFrameSchema, workspaceConfigTopicFrameSchema, helloMessageSchema } from '${shared.replaceAll('\\', '/')}/zcode-protocol-v4/transport.ts';
    export { v4AttachmentBeginParamsSchema, v4AttachmentChunkParamsSchema, v4AttachmentCommitParamsSchema, v4AttachmentAbortParamsSchema, v4AttachmentReadParamsSchema } from '${shared.replaceAll('\\', '/')}/zcode-protocol-v4/transport.ts';
  `, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: 'lib/zcode-wire.js',
  metafile: true, legalComments: 'inline',
  plugins: [{ name: 'reference-aliases', setup(b) {
    b.onResolve({ filter: /^@zcode\/rpc$/ }, () => ({ path: resolve(ref, 'packages/rpc/src/index.ts') }));
    b.onResolve({ filter: /^@zcode\/model-option-map$/ }, () => ({ path: resolve(ref, 'packages/model-option-map/src/index.ts') }));
    b.onResolve({ filter: /^@zcode\/shared$/ }, () => ({ path: 'shared-shim', namespace: 'shim' }));
    b.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({ contents:
      `export * from '${shared.replaceAll('\\', '/')}/web-remote-control-rpc-transport.ts';`, loader: 'ts', resolveDir: process.cwd() }));
    b.onResolve({ filter: /^zod$/ }, () => ({ path: resolve('node_modules/zod/index.js') }));
  } }],
});
for (const file of ['LICENSE', 'THIRD-PARTY-NOTICES.md']) await copyFile(resolve(ref, file), resolve('licenses', `ZCode-${file}`));
await copyFile('node_modules/zod/LICENSE', 'licenses/Zod-LICENSE');
await writeFile('licenses/upstream.json', JSON.stringify({ repository: 'https://github.com/zai-org/ZCode', commit: sha,
  inputs: Object.keys(result.metafile.inputs).filter(x => !x.startsWith('node_modules')).sort() }, null, 2) + '\n');
console.log(`Built pinned ZCode transport: ${sha}`);
