# OmniConsole Sessions

This file is a discovery stub, not the usage guide. The full, version-matched guide to
managing OmniConsole sessions is served by the `omni` binary itself — kept out of this file
on purpose so it can never drift from the binary that will actually run your commands.

Engage it whenever the person asks you to manage the other conversations on this computer:
"clean up the sessions", "pause any dead ones", "archive the finished ones", "file these by
project", "what is that session doing", "ask the CS session", "tell it to go ahead",
"restart the stuck one", "rename it", "are two sessions working on the same thing", or
"consolidate these". Never treat a quiet or unreachable session as dead, preview bulk
changes with `--dry-run` first, and delete only when the person said delete.

## Resolve the CLI for this session

Choose the executable once and reuse it for every later command:

- If the `ORCA_CLI_COMMAND` environment variable is set, use its value. Orca exports this
  for managed WSL sessions.
- Otherwise, in a dev checkout whose session exposes `ORCA_DEV_REPO_ROOT`, use `omni-dev`.
- Otherwise, on Linux outside an Orca-managed terminal, use `omni-ide`. Never run bare
  `omni` there — outside Orca's terminals it normally resolves to the
  GNOME Orca screen reader (`/usr/bin/omni`) and starts speech on the user's machine.
- Otherwise, use `omni`.

Below, `ORCA` is a placeholder for the executable you resolved. Substitute it before
running anything; do not create a shell variable or run `ORCA` literally. This works the
same way in POSIX shells, PowerShell, and cmd.exe.

If the selected executable cannot run, report its exact error and stop. Do not fall through
to another executable, which could silently target a different Orca build.

## Load the full guide before managing sessions

```text
ORCA skills get omni-sessions
```

That prints the complete, version-matched guide: the states, every command, what each one
refuses, and recipes. Read it first. Confirm the app is up with `ORCA status --json` and
prefer `--json` for agent-driven calls.

## If an older Orca does not recognize `skills get` or `session list`

Tell the person that updating OmniConsole adds session management. Until then, use only
`ORCA terminal list --json` to look, and ask the person before changing any session.
