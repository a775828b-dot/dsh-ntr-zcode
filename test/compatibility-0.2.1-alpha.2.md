# DSH 0.2.1-alpha.2 Compatibility

Date: 2026-10-13. Plugin: 0.4.1. Official tag: `dsh-v0.2.1-alpha.2`,
commit `d743267388` (prefix). This is a prerelease, not a stable DSH release.
Source: [official release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-alpha.2).

## Results

| Check | Result |
| --- | --- |
| Unmodified official source, locked dependencies, `pnpm run build` | Passed |
| Built DSH CLI `--version` | `0.2.1-alpha.2` |
| Plugin `npm test` | 66/66 passed |
| Chrome `--live --flows --audit` | Passed; projects, drafts, model/reasoning selection, stop/continue, reload, rename, copy, themes |
| Chrome `--live --features` | Passed; GLM to DeepSeek Account, all permission modes, images, reload, preview, zoom, download bytes, image-only send |
| Chrome `--live --extended` | Passed; approval, questions, queues, TXT attachment, plan, goal, fork, pin/rename, archive/restore |
| Chrome `--live --history` | Passed; 230 synthetic messages, paging, compaction, strict title synchronization |
| Uncaught original-page JavaScript exceptions | Zero in all four runs |
| Windows packaging `--check` | Local configuration and toolchain passed; not an installed-desktop test |

No plugin runtime incompatibility was found within this scope. Runtime code and
package version remain 0.4.1; this change adds a test preflight and documentation.
The newer Host's `sequenced` projection discriminator and additional list metadata
do not prevent the tested operations from using the existing `values` fields.
Old-format session migration is not certified by these synthetic current-format tests.

## Reproduction

Build the official tag before running from the plugin repository:

```powershell
$env:DSH_SOURCE = 'path-to-built-deepseek-harness-checkout'
$env:PLAYWRIGHT_MODULE_PATH = 'path-to-playwright-module'
$env:DSH_EXPECT_VERSION = '0.2.1-alpha.2'
npm test
node test/real-host.mjs --live --flows --audit
node test/real-host.mjs --live --features
node test/real-host.mjs --live --extended
node test/real-host.mjs --live --history
```

The preflight checks the reported CLI version against the source manifest and
optional expected version. DSH's own `readClientBuildRecord` validates the client
artifact digest; its recorded version and source commit must match the checkout.
It is not a complete Host artifact integrity audit. Always complete the build.

## Boundaries

- Google Chrome, original ZCode page and official relay, real isolated DSH Host
  and persistence. All prompts and attachments are synthetic test fixtures.
- Model output uses deterministic replay, not paid provider calls. This does not
  establish iPhone/Safari, HEIC, arbitrary network failure, or full ZCode parity.
- The existing upstream Tooltip and dialog accessibility warnings remain;
  they did not cause uncaught exceptions in these runs.
- Desktop replacement and first launch are separate from this source Host
  verification. Back up the DSH home before upgrading; do not assume downgrade
  safety after a newer runtime writes session data.
- No private profiles, credentials, pairing links, build logs, or screenshots
  are published with this record. Existing limitations remain in the README
  and [button audit](audit-0.4.1.md).
