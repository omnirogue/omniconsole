# Conversation launcher ("+")

The Conversations **+** (`NewConversationButton`) is the one launcher: its menu lists the usable
providers (`LAUNCHER_PROVIDERS` filtered to `status === 'usable'`), a click on a row launches that
provider with the launcher defaults, and Claude, Codex and OMP rows open a submenu (account →
model → effort, or OMP models). Every launch goes through `useConversationLaunch` with the pick
wrapped by `withLaunchTemplate` (agent template + session context for the target). Each folder
heading mounts its own **+**, which files the new conversation in that folder; a folder is a
label, not a directory. The agent template side is described in
[`local-ollama-agent-templates.md`](./local-ollama-agent-templates.md#agent-templates).

## Launch palette

Provider icons sit immediately right of the toolbar **+** (`LauncherPalette.tsx`), one per usable
provider, so a launch is one click. They are shortcuts into the same launcher, not a second one:

- **Click** starts exactly what the provider's menu row starts,
  `start(withLaunchTemplate({ agent }, target, local))`, at the target the **+** would use.
- **Right-click** (or a touch long-press) opens that row's existing submenu at the pointer
  (`LauncherProviderSubmenu`, shared with the menu). Choosing a leaf launches with its account,
  model and effort. Off-host the account column stays unavailable, as in the menu. Providers
  without a submenu ignore right-click.
- **Drag** carries `application/x-omni-launch-intent` with `{ agent }` (provider defaults; picks
  from the right-click menu are not carried). The type is in `isSessionSidebarDrag`, so the
  preload drop guard lets it through, and the in-flight intent lives in
  `lib/launcher-intent-drag.ts` because `dragover` cannot read payloads.

Drop targets, on the Sessions surface only, highlight while an intent is in flight:

- **A session row** makes that session's workspace the launcher target and queues the pick; the
  toolbar **+** starts it once availability for that target has loaded, then the target resets as
  after any launch. A workspace on a paired host shows "Launching on <host>" (the conversation
  opens there, not in a local tab); a target whose agents never load is dropped after 20 s with
  "Cannot launch here".
- **A folder heading** queues the pick for that folder's own **+**, which launches at the current
  launcher target and files the new conversation in the folder.

A queued drop carries the target it was dropped with (`PendingLaunch.target`), and its owning
**+** launches there even if another launch settles and resets the shared target meanwhile; the
drop releases the shared target afterwards only if it is still the one it set. One drop waits at
a time: a second drop while one is waiting is refused with "Launch already starting". A drag
ends when its icon disappears, on any drop, on dragend and on Escape. Closing the right-click
menu returns focus to the provider icon.

Worktree cards, Task / Outcome / artifact rows and the terminal area do not accept launch intents.
The **+** remains the keyboard entry point.
