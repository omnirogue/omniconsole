---
name: computer-cleanup
description: Review CPU and memory use, close unused OmniConsole browser pages with a saved reopen list, and inspect leftover terminals or Chrome tabs. Use for computer cleanup requests; preserve active work and target the named computer.
---

# Computer cleanup

Use the installed `omni` CLI for OmniConsole state. Read `omni status --json` and name the computer being inspected. For another paired computer, use the same explicit `--environment` on preview and apply. An SSH terminal belongs to its execution host; inability to contact it is not proof it exited.

## OmniConsole browser pages

The app button is **Settings → Browser → Clean up browser pages → Review pages**. It targets the computer running that desktop window. The CLI uses the same cleanup engine:

```sh
omni tab cleanup --json
omni tab cleanup --apply <token-from-preview> --json
```

Preview defaults to unused pages. Use `--all` during preview only when the person requests all pages; this includes the current page but retains the same checks. Show the eligible count and kept reasons. A cleanup request authorizes applying its matching preview; an analysis-only request does not. Tokens expire after two minutes and cannot be reused. If the preview expires, get a new one and check its scope.

The engine rechecks page ownership and content before closing. It keeps pinned pages, downloads, annotations, pages driven by agents or other devices, detected forms/editors, workspace documents, and pages it cannot inspect. This is a conservative check, not proof that every web app has saved its state. Do not bypass a kept reason with a raw close merely to reach a target count.

The host saves `reopenPath` before closing anything. Report actual `closed` outcomes, not the preview count. The UI offers Reopen for each confirmed closed page. A saved URL restores its address and profile, not unsaved content or browser history. A `prepared` record after an interrupted call is a recovery list, not evidence of closure: compare it with a fresh `omni tab list --worktree all --json` before reopening anything. Do not replay an ambiguous apply.

On an old build, `tab cleanup` or `browser.cleanup` is unavailable. Explain that the app needs the cleanup feature update; keep the operation read-only instead of silently substituting another cleanup method. Headless hosts and pages hosted by a different browser client remain out of scope for this first version.

## Terminals: review existing controls first

```sh
omni terminal list --json
omni terminal show --terminal <handle> --json
omni terminal read --terminal <handle> --screen --limit 30 --json
```

The status-bar Resource Manager already lists terminals by workspace and offers **End orphan terminals** for unbound PTYs with verified absent agent ownership. That classification alone does not prove a bare shell has no child jobs or unsent input; inspect those before a requested cleanup.

Check Session Steward and agent hibernation settings before proposing another schedule. They already handle blank agent conversations and sleeping idle agents. Archiving a conversation does not itself prove its process stopped. Bare shell tabs need separate evidence.

For a requested shell cleanup, verify the exact terminal handle and current PTY incarnation, a blank prompt with no unsent input, no child or stopped jobs, and no queued work. Recheck immediately before using the existing `omni terminal close --terminal <handle> --json`, then verify the pane and process are gone. Keep unknown or remote-unverifiable terminals. `terminal close` has no dry-run option. Do not send `exit`, use broad process-name kills, or close a whole tab containing another active pane. Use `--tab` only when the whole tab is the confirmed target.

## Chrome and macOS

Inspect Chrome's existing Memory Saver setting before suggesting new automation. Prefer its built-in suspension. Closing Chrome tabs is a separate action: inventory and select the requested tabs, preserve draft/active pages, and save their URLs before closing. Do not create a blanket timer that closes arbitrary Chrome tabs.

WindowServer is macOS's desktop compositor, including windows, displays and remote desktop sessions. Reducing open windows may reduce its work; removing or killing it can end the graphical session. Never include it in application cleanup.

Measure memory pressure, swap growth and process footprint before and after cleanup. RSS totals double-count shared memory; do not present them as freed RAM. Report the observation time, computer and source.
