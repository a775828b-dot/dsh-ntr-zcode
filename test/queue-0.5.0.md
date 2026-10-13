# Queue Controls: 0.5.0

Date: 2026-10-13. DSH source Host: `0.2.1-alpha.2`, commit
`d743267388641bc76f17c45ce8b4c231aed1d32c`. ZCode protocol reference:
`aac4755666d09fdcd70272fcf063c077a639015f`.

## Implementation

- `reorderQueueItem`: validates both occurrence IDs and commits one Inbox splice.
  The original DSH messages, source request IDs and attachment references survive.
- `setAutoDrain(false)`: gates the next `turn/start` before Inbox claim, leaving the
  current reply alone. DSH may record an empty interrupted boundary for the parked
  turn; it does not call the model or consume that turn's queued input.
- Stop: cancels the active turn with `keepInbox`, pauses the queue and any active goal.
- Resume: waits for pending stop convergence when necessary, then wakes the real
  DSH Agent without adding a synthetic prompt or changing FIFO order.
- `sendQueuedNow`: pauses admission, stops the current turn, waits for real idle,
  rechecks scope/identity/item presence, promotes the selected occurrence, then
  resumes normal draining. A later Stop supersedes the pending promotion.
- Queue commands share a per-session lock. Command IDs are deduplicated. An old
  global revision is accepted only when its previously delivered queue snapshot
  still matches; stream-only updates do not incorrectly invalidate a queue action.
  Changed queue state, unknown revisions and mismatched epochs are rejected.

No DSH source modifications, private driver methods or plugin-owned message queue.

## Verification

| Check | Result |
| --- | --- |
| `npm test` | 86/86 passed, including 20 queue-specific cases |
| 200 deterministic reorders | Identity, content, attachment and membership invariants passed |
| Stop concurrency and revoked scope | No promotion or wake after superseding Stop/disposal/revocation |
| Chrome `--live --flows --queue` | Phone/desktop drag, paused reload, promotion, exact consumption order, resume, real interruption and historical image preview after reload passed |
| Chrome `--live --features` | Model/provider changes, permissions, image-only and image/text, preview/zoom/download passed |
| Chrome `--live --extended` | Approval/questions, existing queue edit/delete, files, fork, plans/goals and archive/pin passed |
| Chrome `--live --history` | 230-message paging, compaction and title synchronization passed |
| Uncaught browser JavaScript exceptions | Zero in all four final suites |

The queue suite uses the original hosted ZCode page and official WSS relay, a real
isolated DSH Host, Google Chrome at mobile and desktop viewport sizes, and deterministic
model replay. It compares the real Inbox and persisted user-message IDs/content,
not only rendered text. Pause-only is tested through the real protocol using an
isolated authenticated fixture endpoint because the original page exposes Stop
and Continue, not a standalone pause-only button. Fixture endpoints do not ship.

## Limits

- The pause policy is process-local. Browser reload/re-pairing retains it; full DSH
  restart or plugin reload resets it. DSH owns persistence of queue contents.
- Paused session admission also covers desktop submissions. Resume from the mobile
  queue before continuing. Plugin unload cancels paused active work with Inbox retained.
- No iPhone/Safari device, paid model API or DSH 0.2.0-rc.2 certification for the new
  queue implementation. Earlier 0.4.1 results remain historical.
- Original-page Tooltip warnings remain. Queue image transitions produced transient
  revoked-blob resource warnings; these are not uncaught JavaScript exceptions.
- Stop/promotion cannot undo external side effects already performed by tools.
- `modelExecution`/Highspeed credentials are rejected rather than forwarded to DSH.

## Reproduce

Use the dependencies/environment described in README, then run suites separately:

```powershell
$env:DSH_EXPECT_VERSION = '0.2.1-alpha.2'
npm test
node test/real-host.mjs --live --flows --queue
node test/real-host.mjs --live --features
node test/real-host.mjs --live --extended
node test/real-host.mjs --live --history
```

Private test profiles, pairing URLs, browser screenshots and raw logs are ignored
and are not included in the repository or package.
