# Verification: Dsh ntr Zcode

Latest: [0.5.0 queue controls and regressions](queue-0.5.0.md), DSH 0.2.1-alpha.2.
The historical 0.4.1 results below describe that release, not the latest queue implementation.

DSH: 0.2.0-rc.2. ZCode protocol reference:
`aac4755666d09fdcd70272fcf063c077a639015f`.

Additional compatibility run on 2026-10-13: DSH 0.2.1-alpha.2 source Host,
all four Chrome groups passed without plugin runtime changes. See the
[version-specific record](compatibility-0.2.1-alpha.2.md) for evidence and limits.

## Historical 0.4.1 Audit

The strict `--history` regression now passes: a desktop rename reaches both the
home list and conversation header, including reopen, paging and compaction.
The extended suite also verifies a rename while pinned, without changing Host membership.
See [the 0.4.1 button audit](audit-0.4.1.md) for unsupported and unverified controls.
This audit does not certify full button parity or readiness for a stable release.

0.4.1 checks: `npm test` covered 66 cases. `--flows --audit`, `--history` and
`--extended` passed against Google Chrome and the original hosted web page, with
no uncaught page exceptions. Draft cleanup archives only owned, unused sessions
and leaves an existing blank fixture untouched. Theme validation includes the
upstream `zai-light` and `zai-dark` values. Image coverage is recorded in the audit.

## Passed

- `npm test`: 66/66 tests, including scope isolation, concurrent command deduplication,
  unsupported input rejection, removed-session access revocation, delayed response
  cancellation, asynchronous snapshot failure handling and credential rotation.
- `node test/real-host.mjs --live`: original `zcode.z.ai/remote/v4` page and official
  `wss://zcode.z.ai/ws` relay connected to a real, isolated DSH Host.
- A DSH-created session appeared in the original mobile page; existing history
  rendered, mobile input entered the same DSH session, and agent text streamed back.
  The Host history endpoint flushed session storage and contained both messages.
- Actual DSH settings controls: select workspace, consent, start, copy link,
  refresh QR (different device identity), stop (QR removed).
- `node test/real-host.mjs --live --flows`: Google Chrome, original unmodified
  ZCode page and official relay, with these observed assertions:

| Browser action | Host/data assertion | Result |
| --- | --- | --- |
| Switch between two projects from mobile home | Both are explicitly shared DSH workspaces | Passed |
| Create a new session and send its first message | New real DSH session ID; same history stream | Passed |
| Choose `deepseek-pro` and high reasoning | DSH model projection records `deepseek-pro` / `high` | Passed |
| Change existing conversation to flash/low and send | DSH projection records `deepseek-flash` / `low` | Passed |
| Stop a hanging test response | Original stop button returns to idle | Passed |
| Continue after stop | Next real DSH turn returns a response | Passed |
| Return to directory, refresh and reopen | Original history is visible | Passed |
| Reload the mobile webpage | Same conversation and history restored | Passed |
| Permission modes | Original page modes map to actual DSH permission presets | Passed with local opt-in |

## 0.3.0 Regression

The reported `guard.dshUnsupported` was triggered by the old send guard rejecting
`mode: yolo`, rather than a DeepSeek-account selection failure. The user's desktop
GLM entry exposes only `max`; having no alternative reasoning level is correct.

`node test/real-host.mjs --live --features` uses the original page and official relay:

| Action | Evidence |
| --- | --- |
| Existing GLM session to DeepSeek-account model, full access | Accepted send; real model and permission projections verified |
| Upload a PNG with text | Original begin/chunk/commit; DSH durable image attachment ID recorded |
| Reload mobile webpage | Authorized attachment read succeeds; Chrome image has nonzero natural width |
| Send an image without text | Original send accepted; real DSH turn completed |
| Confirm-before-changes mode | DSH permission projection becomes `read-only` (conservative, stricter mapping) |
| Auto-edit mode | DSH permission projection becomes `workspace-write` |

Image boundaries covered by unit tests: maximum bytes/count, SHA-256, chunk retries,
multi-chunk ordering, malformed Base64, MIME checks, scope/TTL revocation and buffer
release. DSH performs the full raster decode; invalid image data is rejected before
the prompt starts. Permission writes require a separate local opt-in, use the
canonical `/permission` command, and are checked against the resulting projection.
The screenshot `image-preview-mobile.png` shows the durable PNG after a browser reload.

The regression reproduces the reported new-session failure in 0.1.0. Fixes include
null-session creation, the model picker's required API-type marker, real catalog
mapping, and storing the validated mobile view state for reloads.
- Screenshots inspected at desktop 1280x720 and mobile-width 390x844:
  `real-host-settings.png` and `real-host-mobile.png`. No live QR is captured.

## Boundaries

- Chrome viewport testing is not an actual iPhone/Safari test.
- Model output came from DSH's official deterministic replay provider, not a paid API.
- Tests use synthetic messages in isolated profiles, not the user's existing data.
- Directory subscriptions now poll and push changes. Chrome verified a desktop rename appearing without a mobile refresh.
- This remains a partial adapter, not full ZCode parity. New project directories,
  file explorer/terminal/Git review, credentials/global settings, bots, plugin/MCP/Skills
  administration and subagent controls are not implemented. See the matrix below.
- Successful public-relay compatibility is not an uptime guarantee or permission
  agreement with its operator. WSS is transport encryption, not end-to-end encryption.
- Test processes and pairing connections are closed at completion. Temporary local
  authentication files are cleared. Credentials are not part of the package.

## 0.4.0 Extended Chrome Verification

Google Chrome (`channel: chrome`), original unmodified page, official relay, isolated
real DSH Host. Mobile 390x844 and wide 1440x960. Buttons, menus, typing, file picking,
scrolling and hover were exercised; Host projections/inbox/membership were asserted.
These are automated UI tests, not a claim that every possible human action was tested.

| Priority | ZCode control | DSH mapping | Evidence / remaining boundary |
| --- | --- | --- | --- |
| P0 | Projects, sessions, new task | Shared workspace + session controller | Chrome flows; no new filesystem directory creation |
| P0 | Send, stream, stop, continue | Existing agent prompt/cancel | Chrome; stop retains pending queue |
| P0 | Model and reasoning | Real model catalog/selection | Chrome GLM to DeepSeek Account; no live paid API |
| P0 | Three permission modes | Canonical permission command | Chrome all three; confirm mode is stricter read-only |
| P0 | Allow/reject approval | DSH approval waterfall | Chrome allow once + reject; explicit desktop opt-in |
| P0 | Structured questions | DSH userQuestions | Chrome option + custom answer; timed claim/snooze unit-tested only |
| P0 | Image upload/history | DSH durable images | Chrome PNG with text, image-only, reload/preview; other raster validation unit-tested |
| P0 | Pairing revoke/reload | Relay lifecycle, scope guards | Chrome copy/refresh/stop/reload; stale proof, duplicate commands and scope isolation unit-tested |
| P1 | Queue, edit, remove | DSH Inbox and receipts | Chrome admission, withdrawal, resend and removal |
| P1 | Guide follow-up | DSH next-step steering | Implemented and unit-tested; not interruption |
| P1 | Queue immediate send/reorder/auto-drain | Public Agent Inbox splice/send/cancel/whenIdle and turn admission gate | Added in 0.5.0; see queue verification record and lifecycle limits |
| P1 | Ordinary attachments | DSH file upload receipts | Chrome TXT durable upload; no general-file browser preview |
| P1 | Older messages | Controller page at snapshot cut | Chrome scroll through 230 synthetic persisted messages |
| P1 | Compact | Canonical /compact | Chrome actual compact checkpoint and completion marker |
| P1 | Plan / todo status | /plan and todos projection | Chrome actual todo_write call and plan projection |
| P1 | Goal create/pause/resume/stop | Canonical /goal commands | Chrome actual phase transitions; not ZCode independent verifier |
| P1 | Tool output / reasoning / tokens | DSH events/projections/stream | Unit coverage including live reasoning and JSON arguments; actual todo/tool and token UI; live reasoning not Chrome-verified |
| P1 | Fork assistant | Controller fork at event seq | Chrome new real session; original branch preserved |
| P1 | Desktop title/index updates | Scoped directory polling | Chrome renamed title appears without reload |
| P1 | Pin/unpin/archive/unarchive | Workspace controller membership | Chrome wide hover + confirmation; persistent membership checked |
| P2 | File tree and Git review | Requires new scoped services | Not implemented |
| P2 | Terminal | Requires terminal lifecycle and separate authorization | Not implemented |
| P2 | Retry/edit old prompt/rewind | Needs precise branch and tool-side-effect semantics | Not implemented |
| P2 | New project directory | Needs desktop-approved filesystem scope | Not implemented |
| P2 | Subagent panels/control | DSH ownership model differs | Not implemented |
| P3 | Settings, providers, secrets | Separate administrative surface | Not implemented; secrets never forwarded |
| P3 | Skills/MCP/plugin/bot management | Host-specific administration | Not implemented |
| P3 | Theme, copy, navigation | Original webpage local behavior | No DSH adapter needed; not all themes/shortcuts tested |

Regression fixes found through UI testing: implicit queue routing; duplicate approval
ACKs; independent-plan capability negotiation and bare `/plan` syntax; nested DSH
goal projection; stopping an active goal; optional epochs on non-row CAS commands;
old-history title isolation; relay INTERNAL recovery during phone reload and suppressing
business frames while unpaired. Authentication errors still revoke the pairing.
No successful result is fabricated for unsupported writes.

Timing/network coverage is bounded: timeout/abort/disconnect fallback and stale requests
have unit tests; arbitrary mobile network failures, multiple concurrent phones, Safari
background suspension, HEIC conversion, and very large histories remain unverified.
Upstream React Tooltip controlled/uncontrolled warnings remain visible in Chrome logs.
