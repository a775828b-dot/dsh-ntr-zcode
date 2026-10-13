# Dsh ntr Zcode

[中文](README.md)

Experimental protocol adapter for DeepSeek Harness 0.2.0-rc.2. This is an independent plugin, not an official ZCode product. It does not modify DSH or run a second agent.

## Connection

Open DSH Settings > Dsh ntr Zcode, select the workspaces to share, acknowledge remote access, and enable it. Scan the QR code with the iPhone camera and open the link in Safari. The plugin uses the original `https://zcode.z.ai/remote/v4` page and `wss://zcode.z.ai/ws` relay, not a LAN server or a custom mobile page. DSH must remain running and connected to the internet.

The original page's session IDs are mapped to DSH session IDs. Prompts execute in the existing DSH agent with its existing permissions. Model and reasoning choices are read from DSH's real model catalog; no API keys or provider endpoints are sent to the mobile page. As in the original ZCode page, draft choices take effect when sending the next message. DSH's standard model-selection API also updates its default model in the background, just as the desktop selector does.

## Supported In 0.4.0

- Explicitly selected, registered DSH workspaces and their existing sessions.
- New sessions in shared workspaces, including the original page's draft/prewarm creation.
- Selection of existing DSH models and their actual supported reasoning levels.
- Paged text history, live text updates and final responses. Chrome verified 230 durable DSH messages.
- Text and image submission to idle sessions and stopping the current task.
- PNG/JPEG/WebP/GIF and generic file uploads through the original chunk/checksum protocol and DSH durable receipts. Up to four attachments per message, 8 MiB each. Raster images have history previews. HEIC/SVG image decoding and general file history previews are not supported; attaching audio/video as files does not imply playback or model understanding.
- Real DSH permission changes when explicitly enabled in local plugin settings. Web draft changes apply on submission, like model choices.
- Start, stop, refresh QR code, and copy link in DSH Settings.
- Request deduplication for the lifetime of the current pairing; unsupported remote mutations fail explicitly.
- Restoring the active shared session after reloading the mobile page.
- Opt-in remote approval (allow once/reject) and structured questions. Disconnect or a 120-second timeout returns ownership to the desktop, never automatic approval. Timed questions retain DSH deadlines and support one bounded snooze.
- Real queued submissions, withdraw/edit/delete, and next-step steering. Immediate stop-and-send, queue reordering and auto-drain suspension remain unsupported.
- DSH plan mode, todo projection, goal creation/pause/resume, and pausing active goals when stopping generation. Goal completion is not a ZCode independent verification result; goal timing/verification history is not mapped.
- Assistant-message forks, pin/unpin, archive/unarchive and desktop directory updates pushed to the phone.
- Tool input/output, live and durable reasoning text, context/token counters, and canonical manual compaction with a completion marker. Live reasoning is unit-tested, not Chrome-verified.

This is NOT full ZCode feature parity. New workspace directories, terminal/file explorer/Git review, provider credentials/global settings, MCP/Skills/plugin administration, bots and subagent controls remain unsupported. Original controls may still be visible. Remote approval requires a separate local opt-in before pairing; requests already owned by the desktop stay there. Stopping a DSH turn retains the queue rather than pausing its automatic consumption. See the verification matrix for implemented, tested and unsupported controls.

Cross-project navigation uses the original mobile home: return to the task home and choose the shared project there. The inline project picker lists the current bridge's local tabs, not every shared DSH workspace.

## Permission Mapping

| Original ZCode label | DSH preset | Semantics |
| --- | --- | --- |
| Confirm before changes | read-only | Conservative mapping: stricter than ZCode; DSH handles any escalation |
| Auto edit | workspace-write | Workspace modification; wider operations remain subject to DSH approval |
| Full access | danger-full-access | Full DSH permissions |

Enable the local checkbox allowing remote permission changes **before starting pairing** to permit these writes. It is off by default. Without it, only a mode matching the session's existing DSH preset is accepted. The adapter uses the canonical `/permission` command, checks the resulting projection, and never changes deployment defaults. Read-only is not identical to ZCode's confirm-before-edit semantics. Incoming requests cannot issue arbitrary slash commands through this mapping.

GLM reasoning choices reflect the desktop catalog. A GLM entry configured with only `max` has no alternative level to choose; the plugin does not invent unsupported levels.

Pending attachments are pairing/workspace/session scoped, limited to 24 MiB total and expire after ten minutes. A successful send frees upload buffers; DSH retains durable data. Stop/refresh clears pending uploads. Reads validate durable session references, never client-supplied filesystem paths.

## Security And Expiry

- Disabled by default. Only selected workspaces are exposed. The local settings API is under DSH's authenticated `/api` transport.
- Links/QR codes are bearer credentials. Do not post screenshots or send them to other people. Anyone holding a valid link can read shared sessions and issue DSH tasks with the existing session's privileges.
- WSS encrypts each transport hop; this is **not end-to-end encryption**. The original ZCode page and official relay are trust dependencies.
- Credentials are memory-only. Stop, refresh, plugin reload, process restart or connection failure discards the active bridge. Old links cannot access this plugin afterward. An already-accepted DSH task may continue on the desktop after remote access stops.
- There is no plugin-imposed timed expiry. The official relay's server-side retention/expiry is undocumented and is not guaranteed. Refresh manually after a device-side network error. Phone browser reconnection can re-open a bridge while the device pairing remains active.
- Third-party use of the public relay is a technical compatibility result, not a service agreement or stability guarantee. Upstream deployments can break compatibility.

## Build And Tests

`npm ci --ignore-scripts` installs package dependencies. The committed `lib/zcode-wire.js` is a pinned bundle of the official transport/RPC and validation code, not the ZCode agent. `licenses/upstream.json` records its commit and source inputs; upstream Apache-2.0 and Zod MIT notices are included. Rebuilding requires the reference checkout described in `build-vendor.mjs`, then `npm run build:vendor`.

- `npm test`: local scope, deduplication, projection and lifecycle tests.
- `node test/live-web.mjs --live`: official web/relay with synthetic backend data only.
- `node test/real-host.mjs --live`: original mobile page, official relay, real isolated DSH profile, agent and persistence, with deterministic official LLM replay (no paid API calls). Requires the built sibling DSH source checkout and Chrome/Playwright.
- Add `--flows` for new-session, real model/reasoning selection, stop/continue, directory return and reload regression coverage.
- Add `--features` for GLM to DeepSeek-account selection, all three permission mappings, original chunked image upload, durable image history and preview after reload.
- Run `--extended` separately for approvals, questions, queue editing/deletion, generic files, forks, live directory updates, plans/todos, goals and pin/archive controls.
- Run `--history` separately for 230-message scrolling and actual DSH compaction checkpoints. It seeds only synthetic messages in the isolated profile.

No test reads the user's existing DSH profile. These tests do not establish actual iPhone/Safari behavior or paid model-provider availability.

## Packaging

Clone this repository and run `./scripts/install.ps1` in PowerShell after closing DSH. Node.js 22+ is required. It installs dependencies, tests and packs this plugin and uses the desktop-bundled DSH plugin installer. Use `-PackOnly` to build without installation or `-DshCli` for a non-default CLI location. Installation does not enable remote access. Reopen DSH after installation. Upgrades can require adapter changes because DSH plugin APIs are pre-stable; installing as a plugin avoids edits to official source but does not guarantee perpetual API compatibility.

For integration tests, set `DSH_SOURCE` to the built DSH checkout and `PLAYWRIGHT_MODULE_PATH` to an installed Playwright module (defaults to `playwright`). For vendor rebuilds, set `ZCODE_SOURCE` to a ZCode checkout at `aac4755666d09fdcd70272fcf063c077a639015f`. These checkouts, generated test profiles and screenshots are not included. See the Chinese README for complete commands. This repository has not been published to the npm registry.

## License

Apache-2.0. See `LICENSE`, `NOTICE`, and `licenses/` for project and third-party terms and attribution.
