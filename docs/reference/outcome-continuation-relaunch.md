# Outcome-continuation relaunch

Quitting the OmniConsole desktop while a session outcome set is unfinished does not end the process.
The main process relaunches **itself** headless so the outcome keeps advancing. Nothing under `docs/`
said so before, and the behaviour surprised an operator who read `ps` and concluded the app had failed
to quit.

## What happens on quit

`app.on('will-quit')` in `src/main/index.ts` drains its teardowns, then asks
`OutcomeContinuationLifecycle.shouldRelaunch()`. It relaunches only when **all** of these hold:

| Condition                                                                    | Why                                                                           |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| a desktop window opened                                                      | a headless serve owner must not relaunch itself — that is the quit loop       |
| no system shutdown                                                           | `query-session-end` / `session-end` / `powerMonitor` logout must actually end |
| outcomes pending, or review waits open                                       | `SessionOutcomeService.pendingOutcomes()` is non-empty, or a live session waits on its review page (`countOpenReviewWaits`: `waiting`, armed in the last 7 days) |
| this process owns the profile                                                | the single-instance lock fences which instance may adopt the work             |
| no update installing, no replacement already scheduled, no dev parent ending | one replacement, and never against an intentional stop                        |

`outcomeContinuationRelaunchPlan()` then builds the replacement's argv and
`relaunchApp('outcome-continuation', …)` schedules it. Electron starts the replacement only after this
process exits, so the child takes the single-instance lock cleanly.

The child runs `--serve --serve-no-pairing` against the canonical profile, plus
`--outcome-continuation`. It has **no window**. Before teardown, the parent retains its actual listener
port only when a previously connected network-reach device exists. Otherwise it uses port `0`.
The continuation uses the desktop's persisted-device bind policy: a pending or "This computer only"
grant never exposes the listener to the network. Existing pairing credentials and keys are reused.

## The replacement announces itself

Three ways to tell a continuation child from a hung app:

- **`ps`** shows `--outcome-continuation` — the switch exists to be read there.
- **stderr** carries `[outcomes] Running in the background to finish work left by a desktop quit; pending=N reviewWaits=M`.
  (Serve mode reserves stdout for the readiness JSON; everything else goes to stderr.)
- **a notification** fires on launch — `announceOutcomeContinuation()` in
  `src/main/startup/outcome-continuation-notice.ts`, best-effort and skipped where
  `Notification.isSupported()` is false.

To get back in, just open OmniConsole. The second instance hands off to the running owner, which opens
a window (`focusExistingMainWindow`) and promotes itself from serve to desktop. There is no separate
"stop the continuation" control, and killing the process is not one — do it through the window.

## Which switches survive the relaunch

`SAFE_SWITCHES` in `src/main/startup/outcome-continuation-lifecycle.ts` is an allowlist of
**process-shaping Chromium switches only**. Everything else is dropped, because the replacement is a
background process the user cannot see and must not inherit session state.

Audited against every switch the main process actually reads:

| Switch                                                                                                                                                                                | Carried?  | Why                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `--no-sandbox`, `--disable-gpu`, `--disable-gpu-compositing`, `--disable-gpu-sandbox`, `--disable-dev-shm-usage`, `--in-process-gpu`, `--use-mock-keychain`, `--password-store=basic` | yes       | shape the process, carry nothing                                                                                                          |
| `--serve*` (`-json`, `-port`, `-pairing-address`, `-no-pairing`, `-mobile-pairing`, `-recipe-json`, `-project-root`)                                                                  | rewritten | the relaunch pins its own serve shape; inheriting `--serve-mobile-pairing` would expose pairing on a process with no window to confirm it |
| `--user-data-dir`                                                                                                                                                                     | rewritten | pinned to `getCanonicalUserDataPath()`; a stale profile would split the lock                                                              |
| `omni://…` deep links                                                                                                                                                                 | no        | one-use (auth callbacks); replaying one is replaying a credential                                                                         |
| `--remote-debugging-port`, `--inspect`, `-r <preload>`                                                                                                                                | no        | a debugger port on an invisible process is remote control of the user's account with no window to reveal it                               |
| `--environment`, `--pairing-code`, `serve`/`--help` CLI forms                                                                                                                         | n/a       | consumed by the CLI redirect, never by an Electron relaunch                                                                               |
| GPU fallback switches                                                                                                                                                                 | n/a       | re-derived from the `gpu-fallback.json` marker in the profile the child inherits                                                          |

**Nothing is dropped silently.** `droppedSwitches` names every refused flag, logged as
`[outcomes] Continuation relaunch does not carry these switches: …` and stored on the
`app_relaunch_requested` crash breadcrumb. Names only, never values — a dropped token's value can be a
one-use auth code or a profile path, and both channels are readable after the fact.

Widening the allowlist is a security decision, not a convenience one: ask what the switch lets someone
do to a process with no window, and assume the user has forgotten it is running.

## Attaching a debugger

CDP is deliberately not carried across the relaunch, so
`open -g /Applications/OmniConsole.app --args --remote-debugging-port=<port>` on a running app appears
to succeed and never binds — the relauncher child wins the single-instance lock in serve mode. To get a
CDP-enabled instance:

1. Quit the profile-owning instance **normally** (AppleScript `quit`, never `kill -9` — SIGKILL orphans
   the PTY-owning daemon and loses every terminal).
2. Poll for the relauncher child and request a normal quit from it before it finishes starting, so
   `shouldRelaunch()` sees `desktopOpened = false` and the chain stops.
3. `open -g /Applications/OmniConsole.app --args --remote-debugging-port=<port>`.

The `[outcomes] Continuation relaunch does not carry these switches: --remote-debugging-port` line is
the signal that step 2 is required.

## Review waits keep it running too

A live session that published a review page and waits on it (`docs/reference/artifact-review-source-delivery.md`)
needs the 60-second review pass to see the decision, so such waits relaunch the app like pending
outcomes do, and the notice says sessions waiting for a review decision are still watched. Without a
window the pass delivers a decision to that live session, puts it to sleep after the review wait,
and reports states to OmniOS. Only those waits count: an asleep or stalled one needs a window (or
another computer) to advance, and one armed more than 7 days ago is abandoned, so neither keeps a
window-less process running. Without a window the computer also sends no heartbeat, so once its
last state report is two minutes old OmniOS shows it as not checking in.
