# Verification: Dsh ntr Zcode 0.3.0

DSH: 0.2.0-rc.2. ZCode protocol reference:
`aac4755666d09fdcd70272fcf063c077a639015f`.

## Passed

- `npm test`: 32/32 tests, including scope isolation, concurrent command deduplication,
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
- Session lists are read on directory load; index subscriptions currently send an
  initial snapshot. Reopen/refresh the mobile directory to discover desktop changes.
- New session creation and existing-model/reasoning choices are now implemented.
  New project directories, non-image attachments, file/terminal UI, credential
  management and remote approvals remain unsupported. See README.md.
- Successful public-relay compatibility is not an uptime guarantee or permission
  agreement with its operator. WSS is transport encryption, not end-to-end encryption.
- Test processes and pairing connections are closed at completion. Temporary local
  authentication files are cleared. Credentials are not part of the package.
