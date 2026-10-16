# 0.6.0 Image and File Preview Verification

Date: 2026-10-16 (Asia/Shanghai).

## Environment

- DSH source Host: `0.2.1-alpha.2`, commit `d743267388641bc76f17c45ce8b4c231aed1d32c`.
- Pinned ZCode protocol: `aac4755666d09fdcd70272fcf063c077a639015f` (3.15.1).
- Original `https://zcode.z.ai/remote/v4` page and `wss://zcode.z.ai/ws` relay.
- Installed Chrome driven by Playwright, 390 x 844 mobile and 1280 x 900 desktop layouts.
- Isolated DSH profile, durable attachment store and session log. Text model replies use deterministic replay; output-image events are explicit fixture events containing real stored PNGs, not a paid image-model call.
- No personal sessions, credentials, pairing links or screenshots are committed.

## Implemented

- Assistant image blocks become ZCode artifact-image Markdown. Reads use DSH's session-scoped attachment authorization, including a post-read sharing check.
- Tool-result images use an explicitly labeled `DSH tool output` section. Tool results are paired by DSH's actual `toolCallId` field.
- Local Markdown image/file links use the original file preview services, backed by DSH `workspaceFiles`, not unrestricted Node filesystem reads.
- Only references in subscribed shared sessions are admitted. Both the requested and resolved paths must remain inside the shared workspace. Hidden paths, UNC paths, unknown references and oversized files are refused.
- Local file previews show current file contents, not a historical file snapshot. The file identity/version must remain stable during a read. Durable attachments remain content-addressed.
- Durable file blocks receive opaque, session-authorized preview links. Historical input attachments get a clearly labeled preview section without changing original user text or attachment IDs. The section is appended to the turn's final visible message because the original page folds intermediate assistant rows.
- File previews are read-only: no directory enumeration, file writes or external editor launch. Maximum file size: 8 MiB; text/range request limit: 256 KiB.

## Automated Checks

`npm test`: 101 tests passed, including 15 new preview tests covering:

- Markdown links, references, quoted paths and exclusion of fenced code examples.
- POSIX/Windows traversal, encoded traversal, hidden directories, UNC, URI and special-path rejection.
- Image-only assistant output, tool-result attribution, original protocol schemas and chunk slicing.
- Subscription authorization, guessed paths, resolved escape, changed identity/version and in-flight revocation.
- Size/range limits, image signatures, binary text handling, virtual attachment references and filename escaping.
- Preserved original user content and explicit rejection of remote file mutations.

## Chrome Checks

Run separately with `DSH_SOURCE`, `DSH_EXPECT_VERSION` and `PLAYWRIGHT_MODULE_PATH` configured:

```powershell
node test/real-host.mjs --live --previews
node test/real-host.mjs --live --features
node test/real-host.mjs --live --flows --queue
node test/real-host.mjs --live --history
```

Verified preview flow:

1. Desktop-origin durable user image, assistant output image, tool output image and workspace Markdown image all render with nonzero intrinsic dimensions.
2. Each image opens the original enlarged preview and closes normally; all remain readable after a browser reload.
3. A conversation-linked text file opens in the original side panel. Closing the mobile panel uses the exposed backdrop, not a forced click through the panel.
4. Historical file attachments and tool-generated text files open through explicit preview links and show their original bytes, including filenames containing spaces and unmatched parentheses.
5. Real Host rejects an unlinked file, a hidden file, traversal outside the shared workspace, and a Windows directory junction leading outside it.
6. Mobile and desktop screenshots are captured after responsive layout settles; image rendering is checked again after resize.
7. Pairing refresh rotates credentials and stopping disconnects the remote. No uncaught browser JavaScript errors are accepted by the harness.

Model/permission/image-upload, queue and 230-message history/compaction regression suites passed. The queue run retains the upstream transient revoked-blob warning while transitioning a queued image; its final durable image preview after reload passes. Upstream Tooltip controlled/uncontrolled warnings remain diagnostic, not uncaught page errors.

## Boundaries

- Not an iPhone/Safari device test, nor verification that a particular paid model can generate or understand images.
- Only PNG/JPEG/WebP/GIF image paths are enabled; the live output-image fixture tests PNG. HEIC/SVG and audio/video playback remain unsupported.
- Text file preview is verified. PDF/Office viewers can request the scoped binary APIs, but format-specific rendering is not comprehensively tested and is not promised.
- A bare filesystem path in tool prose is not automatically published. Output needs a durable attachment or a Markdown link in session content.
- No production DSH restart or plugin installation is implied by these source-Host tests.

## Package

- `dsh-ntr-zcode-0.6.0.tgz`, 647648 bytes, 22 published files.
- SHA-256: `ea4e27e432503927cd9c89aeb4910e37ca24c516e0e2afb5994019cf47cf6bb9`.
- Package allowlist contains runtime code, manifests, documentation and licenses only; test profiles, screenshots and pairing credentials are excluded.
