# Agent launch

`omni session launch` is the one launcher for unsupervised Claude and Codex agents on every kind
of computer: this one, a paired OmniConsole, or an SSH host. The computer that executes the
agent picks the account with the most fresh verified capacity, pins it, and refuses when it
cannot verify one. Read this before changing agent launch or account selection.

**The rule: never fall back to an unverified account.** No launch path may substitute the
default login, another computer's account, a stale reading, or `terminal create --command`
when verification fails. A refusal names the cause and says "Nothing launched." or "Nothing
was sent."; the caller fixes the cause and runs the same command again.

Supervised Runs keep `omni orchestration worker-start`. The desktop "+" menu also offers
**Need Speed?** for independent objectives; manual launch choices remain available.

## One command

```text
omni session launch --provider claude|codex (--prompt-file <path|-> | --prompt "<text>")
    [--worktree <selector> | --project <name|id> [--name <worktree name>]]
    [--host <computer>|auto] [--model <id>] [--effort <level>]
    [--title <t>] [--title-origin yours|generated|unknown] [--folder <id|path>]
    [--agent-args <flags>] [--agent-template <id>] [--again] [--dry-run] [--json]
    [--operation-id <id> [--controller-runtime-id <uuid>]]
```

Only the provider and one prompt source are required.

- **`--worktree`** defaults to the workspace containing the cwd (`resolveCurrentWorktreeSelector`),
  then `path:<cwd>` so a folder-workspace root resolves. On a remote route the cwd shortcuts are
  refused; pass a server-side selector.
- **`--host`** defaults to the computer that holds the workspace. Given, it is an assertion: a
  workspace on another host refuses with `agent_session_host_mismatch`. It accepts `local`,
  `this computer`, `this mac`, `this machine`, a paired computer's name or id, an SSH target's
  label or id, and explicit `runtime:<name|id>` or `ssh:<label|id>`. `omni host list` prints the
  flag for each computer.
- **`--model` / `--effort`** are optional. On verified new-session launches, automatic routing
  selects an available model and omitted effort within the requested provider on the execution
  owner. It is enabled by default; turn off **Route new objectives from conversation** in
  **Need Speed?**, or set `OMNI_AUTOMATIC_DISPATCH=off` on the executing runtime, to retain host
  defaults. `OMNI_DISPATCH_ROUTER_MODE=shadow` records a proposal without applying it; `off`
  disables model routing. Explicit models, accounts, agent arguments, templates and prepared
  launches keep their choices; an explicit effort is retained when routing an omitted model.
  Routing keeps existing account verification and replay identities. When routing is unavailable,
  the host resolves its defaults with the chosen account's home, unless the router reports a
  blocking refusal. The additive `routing` receipt records `selected`, `shadow`, `off`,
  `unavailable` or `pinned`, separately from `launch.source`; it describes the selection,
  not proof of which model served a response. `--effort` is validated only when the catalog
  knows the model; `--effort` without `--model` needs
  `agent-session.effort-only-launch.v1`. See [Model routing](model-routing.md).
- **`--again`** deliberately starts another copy of an identical launch. Re-running it with
  `--again` starts yet another copy, so every retry hint after an `--again` launch says to run
  the command again without `--again`.
- **`--dry-run`** reads the host (status and readiness preview) and shows the account it would
  pick. It takes no claim, writes no record and never creates a session. A preview is not a
  reservation.
- **`--project`** lets OmniConsole pick the computer and the account (see "Placement and the
  capacity view"). `--host auto` is its synonym and refuses without `--project`.

## Routes and host derivation

`terminal.createAgentSession` is the only launch primitive. The CLI never falls back to
`terminal.create`, and never copies the renderer's legacy fallback or its fence-less replay.

| Route         | Client                               | `sshAccountSelection.expectedHostId`     |
| ------------- | ------------------------------------ | ---------------------------------------- |
| this computer | the local runtime                    | `local`                                  |
| paired        | that environment's runtime           | `local` (it executes its own workspaces) |
| SSH           | the runtime that owns the SSH target | `ssh:<targetId>`                         |

A plain name is canonicalized before routing (`src/cli/launch-host-name.ts`): local aliases to
`local`, a unique paired name to `runtime:<id>`, a unique SSH label to `ssh:<id>`. When a name
matches both a paired environment and an SSH target, the route follows the workspace: the SSH
route only when this computer's readiness resolves `--worktree` to that SSH target, otherwise
the paired route. Ambiguous and unknown names refuse with the known hosts. With `--environment`
or a pairing code already selecting a server, plain names are not rewritten.

`terminal.agentLaunchReadiness` (read-only) resolves the workspace with the launch's own
resolver and returns `{ runtimeId, workspace: { id, hostId, kind, path, name } }`; with
`preview: true` it adds the account it would pick, or `verified: false` with each candidate's
state and reason. With `load: true` (placement) it also returns `load` (`{ loadPerCore, band,
liveSessions, observedAt }` on the executing runtime's clock, or `null`) and `machineId` (the
session host id: the runtime's own for its workspaces, the SSH host's hostStats `host.hostId`
for `ssh:` ones, or `null`). Without `load` neither key is present. Absent and `null` both mean
unknown, never idle. The load read is capped at 4 s, runs beside the account preview, and treats
a reading older than 60 s as unknown. Windows keeps no load average (`os.loadavg()` is zeros
there), so a Windows runtime's own load is `null`, never `ok`, and its `machineId` is still
returned; an `ssh:` host whose relay reported Windows is `null` too, and so is an `ssh:` zero
whose OS this runtime does not know. The CLI also reads a paired or local runtime whose
`status.get` `hostPlatform` is `win32` as unknown. It is not on the unattended-caller allowlist.

## Verdict and freshness

`classifyLaunchAccountRow` (`src/shared/account-launch-verdict.ts`) is the one verdict over the
runtime's own `AccountCapacityService` rows, evaluated in order:

1. `checking` → `unknown` (first reading in progress).
2. `signed-out`, or no `launchEnv` → `signed-out`.
3. Counted windows: the known `fiveHour` and `weekly`, plus `fableWeekly` when Fable is required.
4. `limited`, or any counted window at 0 → `limited` (with `until`).
5. No known 5-hour or weekly window, or no reading → `unknown`.
6. Not `ready`, or older than 60 s (`LAUNCH_ACCOUNT_FRESH_MS`, parity with SSH) → `stale`.
7. Otherwise `fresh`, with the minimum counted remaining percent and the window that bounds it.

At least one known window is enough, so a weekly-only Codex row passes. **`unknown` and `stale`
are never shown as 0% and never treated as available.**

Before choosing, rows older than 30 s that are signed in, not limited and not paused by
Retry-After are force-refreshed, at most 4 at a time, raced against 15 s. A row is forced at
most once per 30 s per capacity service, so a failing endpoint is not hit on every launch; a
launch or preview that finds a row another one forced in the last 30 s waits for that fetch
(within its own 15 s) instead of choosing without it. A reading that arrives late leaves its row
`stale`. This is what makes headless and unfocused hosts work: the background poll runs only
while the window is focused.

The pick is the `fresh` row with the most remaining percent, then the default account, then
`choiceId` ascending.

## System login and Fable

- **System login.** When a managed account is the default, the System row is dropped and
  reported as "not considered: same login as the selected default": a pin to the system config
  directory prepares the selected account (Claude) or restores the system snapshot over the
  managed selection (Codex). When no managed account is selected, the System row is the
  default and a real candidate.
- **Fable.** A model matching `/fable/i` requires a fresh Fable window, which is counted. Codex
  and known non-Fable Claude models ignore it. Otherwise (Claude with the model omitted or
  unknown) it gates: an exhausted Fable window excludes the account without counting it. After
  the host resolves the session's model, a Fable model whose window was not verified refuses
  before spawn. When the account's own settings choose the model the runtime never learns it;
  the receipt says `launch.source: "account-config"`.
- **Fable reading time.** The Fable window is judged by its own reading time
  (`fableReadingAt`), not `readingAt`: a live statusline post refreshes the 5-hour and weekly
  windows but carries the Fable window over. Only a status-ok usage fetch the picker awaited
  sets it. A Fable model needs a Fable reading at most 60 s old, otherwise the row is `stale`
  ("no current Fable reading" or "Fable reading N s old"); `fableVerified` needs the same, and
  the pre-spawn fence re-checks it. For a Fable model, or an omitted or unknown Claude model on
  an account with a Fable window, rows whose Fable reading is older than 30 s are also
  force-refreshed.
- **WSL.** Spawn prepares the WSL-selected login and drops a host account pin, so local verified
  selection refuses whenever spawn would run the workspace in WSL: a WSL path; a project whose
  Windows runtime is WSL or needs WSL repair; or, with no project runtime, a WSL terminal shell
  setting. The pre-spawn fence and the readiness preview apply the same check.

## Pin and fence

- The chosen row's `launchEnv` (a non-empty `CLAUDE_CONFIG_DIR` or `CODEX_HOME`) is pinned into
  the spawn environment, so spawn preflight cannot re-balance onto another account. An empty
  `CLAUDE_CONFIG_DIR` is not a pin and is never produced.
- Selection runs inside the operation's existing reservation, so concurrent same-ID retries share
  one selection; replays return the stored result, including the original account receipt.
- `beforeSpawn` runs synchronously before the PTY spawn and refuses when the request was aborted,
  the workspace changed, the chosen row is missing, changed its `launchEnv` or is no longer
  `fresh`, or a managed account became default after a System pick. A newer fresh reading for
  the same row is accepted. A pre-spawn refusal frees the operation ID, so running the same
  command again launches fresh.
- A runtime restart after the operation was prepared refuses with `agent_session_runtime_changed`
  before selection. An unknown spawn outcome keeps the fence.
- Prepared environments are never accepted from RPC; nothing on the controller names an account.

Remaining window: agent admission and preflight run after `beforeSpawn`, as on SSH. Under a
backlog a reading can age past 60 s, and two launches can pick the same top account. A reading
is a ranking, not a reservation.

## Launch record, intent and claim

Records live on the invoking computer under `<userData>/agent-launch-operations/`, so re-running
the identical command is the retry. Records and intents are written with
`writeDurableSecureJsonFile` (`src/shared/secure-file.ts`): a `0600` file in a `0700` directory,
with the file and the directory fsynced before anything is sent.

- **Record** `<operationId>.json`: the exact `createAgentSession` params sent (prompt included),
  the route, the executing runtime ID read once from `status.get`, the host ID, every send with
  its outcome, the final outcome and the terminal and account receipts. A retry resends the
  recorded bytes and the recorded runtime ID; it never rebuilds the request or re-reads the
  runtime ID.
- **Intent** `intents/<intentKey>.json`: the sha256 of the raw inputs (`--host` as typed, not
  its route; environment, worktree or cwd, provider, model, effort, prompt hash, agent args,
  template, folder; not the title) points at the current operation. With `--project` the
  project (as typed) joins the key, and the cwd, `ORCA_ENVIRONMENT` and the pairing variables
  are left out, because placement never reads them; `--host auto` counts as no `--host`, and
  `--name` is left out like the title. A launch without `--project` keeps the key it had before.
  A re-run whose `--host` now resolves to another route than the recorded one refuses with
  `launch_host_unverifiable`, the operation ID and the record's outcome, and sends nothing.
- **Claim** `intents/<intentKey>.claim` (`src/cli/session-launch-claim.ts`): an exclusive-create
  file held only while planning. A second invocation waits up to 30 s, then refuses with
  `launch_busy` (nothing sent). It steals the claim at once when the claimant's PID is gone,
  and after 120 s regardless, but only while holding the exclusive
  `intents/<intentKey>.claim.steal` lock, under which it re-checks the holder. A steal lock
  whose process is dead, or older than 5 s, is cleared.

Order for a first submission: claim, status, readiness, folder and project brief, build the
request, mint the ID and write the record, write the intent, append the send, release the
claim, print the operation ID to stderr, send, record the outcome. Anything that fails before
the record is written sends nothing; that includes a composed `--folder` prompt over 256 KiB.

A re-run whose record is `created` answers `already-launched` without contacting the host
(unless the title, folder or project steps never finished; those run once more).
Otherwise the CLI re-checks the recorded runtime and resends the same bytes. It mints a new
operation (superseding the old one) only when every earlier send provably started nothing;
otherwise it refuses as `unverifiable`. A supersede re-reads the record under the claim and
refuses if another run already replaced it. An `--operation-id` or intent that names a
superseded operation follows its `supersededBy` chain to the newest record; a broken link
refuses with `launch_outcome_unknown`. Explicit `--operation-id` must match the record's
intent; without a record it needs `--controller-runtime-id`. A host that does not answer on a
re-run refuses with the operation ID and the record's outcome (`not-sent`, `not-started` or
`unverifiable`), never "Nothing was sent" after an unverifiable send.

Records with a known outcome are pruned after 48 h (longer than the host ledger's 24 h);
`pending` and `unverifiable` records are kept for 30 days.

## Send classification

`classifyLaunchSend` is an allowlist. A send started nothing only for `method_not_found`,
`agent_session_operation_invalid`, `agent_session_operation_capacity`,
`agent_session_operation_expired`, `agent_session_runtime_changed`,
`agent_session_operation_conflict`, `agent_session_legacy_required`,
`agent_session_account_unverified` and `agent_session_host_mismatch`. Everything else is
unverifiable: a timeout, a transport loss after the request was written, `invalid_argument`
(handlers throw it too), `selector_not_found`, `runtime_error`, and a send whose outcome was
never recorded. Local socket calls cannot be cancelled and daemon-backed PTYs survive a runtime
restart, so after a maybe-send the outcome is unverifiable, never a grant to launch again.

## Refusals

Every error carries `data.outcome` (`not-sent`, `not-started` or `unverifiable`) and
`nextSteps`, plus `operationId`, `retryCommand` and `inspectCommand` where they apply. A
pre-spawn refusal ends "Nothing launched." or "Nothing was sent."; an unknown outcome never
says either.

| Code                               | When                                                                                                                                                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `incompatible_runtime`             | the routed runtime does not advertise `agent-session.verified-account-launch.v1`, or `--effort` alone without `agent-session.effort-only-launch.v1`                                                        |
| `agent_session_account_unverified` | no fresh verified account; the pick aged or changed before spawn; an unverified Fable window; no account services; WSL workspaces; an old relay                                                            |
| `agent_session_host_mismatch`      | the workspace runs on another host than `--host`, or it changed before spawn                                                                                                                               |
| `agent_session_runtime_changed`    | the executing runtime restarted after the operation was sent or prepared                                                                                                                                   |
| `launch_outcome_unknown`           | no confirmation within 240 s, an expired operation after a maybe-send, or a superseded operation whose replacement record is gone                                                                          |
| `launch_host_unverifiable`         | the host did not answer status or readiness in time, or restarted while planning; a re-run whose `--host` now resolves to another route; `--project`: an unreadable setup policy                           |
| `launch_busy`                      | an identical launch on this computer held the claim for more than 30 s; nothing was sent                                                                                                                   |
| `selector_not_found`               | no workspace contains the cwd                                                                                                                                                                              |
| `invalid_argument`                 | a bad provider, `--host auto` without `--project`, `--project` with a flag that fixes the computer, a mismatched or unrecorded `--operation-id`, an effort the catalog rejects, unknown or ambiguous names |
| `launch_no_computer`               | `--project`: no computer can take the launch now (R17); every computer looked at is listed with why; nothing recorded or sent                                                                              |
| `launch_workspace_unverifiable`    | `--project`: the fresh worktree's create was never confirmed and cannot be resent safely (past the host's dedupe window less 15 s, the host restarted, or a re-run cannot reach it)                        |
| `launch_setup_first`               | `--project`: the chosen repository's setup must finish before its agent starts (`setupAgentStartupPolicy: wait-for-setup`); nothing recorded or sent                                                       |
| `launch_record_incomplete`         | a record whose placement has not finished preparing its workspace was asked to send; run the same command again                                                                                            |

`nextSteps` never suggests an SSH route unless this computer's readiness found a workspace on
that target; the CLI cannot set up SSH targets. A host mismatch whose `--host` chose a paired
computer advises `--environment <name>` instead of `--host`. A route chosen by a pairing code
prints `--pairing-code '<pairing code>'` in `inspectCommand`, `visibleIn` and the cwd-shortcut
hint; the code itself is a credential and is never printed or recorded in error data.

## Placement and the capacity view

`omni session launch --project <name|id>` (or `--host auto` with it) picks the computer and the
account. `omni host list --capacity --provider <p> [--project <id>] [--model <m>]` shows the same
reads without launching. Both use one reader (`src/cli/launch-candidate-reader.ts`) and one
ranking, rule v1 (`rankLaunchCandidates`, `src/shared/agent-launch-placement.ts`).

**Flags.** `--project` refuses `--worktree` (a worktree already fixes the computer),
`--environment`, `--pairing-code`, `--folder`, `--agent-template`, `--operation-id` and
`--controller-runtime-id`. `--host <name>` next to it reads and places on that computer's routes
only; the router leaves `--host` as typed (like `workflow run`). `--name` names the fresh
worktree and needs `--project`. A `--project` name is resolved on this computer; a `github:`,
`git:` or `repo:` id is taken as typed.

**Candidates.** This computer, each paired environment (`new RuntimeClient(undefined, t, null,
id)`), and each SSH target registered on this computer (driven through this computer's runtime).
SSH workspaces behind a paired runtime are listed as `nested-ssh` and not ranked yet.

**Reads.** Read-only, three at a time, 45 s overall: `status.get` (8 s), `projectHostSetup.list`
(8 s), then `terminal.agentLaunchReadiness {preview: true, load: true}` (30 s) on the chosen ready
setup (git first, then the oldest `createdAt`, then the setup id; `id:<repoId>::<path>` or
`path:<path>`). A git setup without a repository record is skipped and named (`no-setup`). The
readiness answer must come from the runtime whose status was read and resolve to the route's own
host (`local`, or `ssh:<targetId>` on an SSH route); otherwise the route is `unverifiable`. A
runtime whose strict readiness schema refuses `load` (`invalid_argument`) is asked once more
without it, and its load is unknown. Every call is capped to the time left in the 45 s
deadline, and none is sent once it has passed. A computer that misses its deadline or
whose transport fails is `unverifiable`: never idle, never 0%. Error text names the code, never
the transport's message. A readiness answer the route rejects describes nothing about it: its
account, load, host and machine id are all dropped.

**Eligible** only when all hold: reachable, `agent-session.verified-account-launch.v1`, readiness
answered, a ready setup of the project (`getProjectIdentityKey`; a `repo:` key only matches
setups this computer registered), `worktree.create-idempotency.v1` for git setups, a verified
account, and a load band other than `hot`. There is no minimum headroom; the receipt shows the %.

**Ranking and dedupe.** Load band (`ok` < `offload` < `unknown`), then measured available RAM
descending, then `floor(remainingPercent / 10)` descending, then this computer first, then paired runtime before SSH, then the label. Routes
merge by machine id only (readiness `machineId`, else `status.get` `sessionHost.hostId` for a
runtime's own workspaces); routes without one are never merged. Optional `load.freeBytes` and
`load.totalBytes` carry the existing host resource reading. Missing/invalid RAM is unknown, ranked
after measured available RAM and before a measured zero. This adds no RAM requirement or forecast. A machine that any of its routes
measured `hot` is hot on every route ("same computer as X, measured …"). A runtime whose
`status.get` `hostPlatform` is `win32` has an unknown load (Windows keeps no load average).

**Workspace.** A git project gets a fresh top-level worktree on the chosen computer through
idempotent `worktree.create` (`clientMutationId: 'launch-' + operationId`, `noParent`), journaled
before the send. It starts from the repo default base, so the caller's branch and uncommitted or
unpushed work do not travel; the guides say to drop `--project` (or replace it with `--worktree`)
for work that needs them. The repository's setup script runs beside the agent, as with
`--setup run` (`runHooks: false`, `setupDecision: 'run'`: an `ask` repository cannot refuse after
`git worktree add`, and nothing is revealed or focused). Before the pick is frozen, the chosen
computer's `repo.hooks`, `repo.hooksCheck` and `repo.show` are read: a repository with a setup
script whose `setupAgentStartupPolicy` is `wait-for-setup` (omni.yaml or Settings) refuses with
`launch_setup_first` and "Nothing was sent", naming `omni worktree create --repo id:<repoId>
--name <n> --no-parent --setup run --agent <p> --prompt "<task brief>" --json [--environment
<name>]`, which sequences setup but does not verify account capacity. A policy that cannot be
read refuses with `launch_host_unverifiable`. A folder project launches into the folder, and the
receipt warns that it is shared. A computer without a ready setup is skipped by name and never
cloned.

**Freeze.** The fleet is read once, read-only, before the claim; under the claim the operation
is minted and the record written with `placement` (rule, project, chosen computer and why, the
runner-up and its exact command, every candidate's state and reason, the workspace plan) and
`request: null`, then the intent. A retry or identical re-run follows that record and never reads
the fleet again. The worktree name is `--name`, else a slug of `--title`, else of the brief's
first line, plus the operation id's last 6 characters. `worktreeCreateSentAt` and
`worktreeCreateRuntimeId` are journaled once, before the first `worktree.create` is sent, and a
resend keeps them; `createdWorktreeId` (and the host's create warning, shown with the receipt
warnings) is journaled as soon as it answers. A re-run resends an unconfirmed create only on the
same runtime and only while time remains in the host's dedupe window (at most 60 s) less a 15 s
transit margin, measured from the first send (45 s by default); its refusal offers "within N s"
only for the time actually left. Past it, or after a restart, it refuses with
`launch_workspace_unverifiable` and the `omni worktree list` command to check. A re-run that
cannot reach the computer after an unconfirmed create refuses the same way, never with "Nothing
was sent" or a runner-up. Only an error the host itself answered clears the journal, so the next
run retries cleanly; that refusal names the `omni worktree list` and `omni worktree rm` check for
a checkout the failed create left behind. A reply this computer could not read is unverifiable
and keeps the journal. Then the PR 1 plan and send run
on the chosen route with `--worktree id:<created id>` (or the folder's `path:`), and the record
gains the exact request. After a definitive pre-spawn refusal on the chosen computer the command
stops and prints the runner-up's exact command (no automatic advance), and reports any created
worktree with its `omni worktree rm` command. It never falls back to this computer. `--dry-run`
shows the ranked computers and the pick, records and creates nothing, and exits 0 when it would
refuse. When this command already froze a pick, `--dry-run` shows that frozen pick, its
candidates as they were ranked and the operation it continues (`continues`), and reads no
computer, because the real re-run follows it; `--dry-run --again` previews a fresh placement.

**Capacity view rows.** One row per physical computer (routes merged by machine id; without one,
each route keeps its own row and the footer says so). Each row shows the best fresh verified
headroom, the bound window, the reading age, verified/considered accounts, the load band,
the project's ready setups (with `--project`), whether a launch can go there now (exactly when
rule v1 could pick it), and why. The footer recommends `omni session launch --project …` (with
`--project`) or the best computer's `--host` command. `--json` returns the same rows
(`LaunchCapacityView` plus `recommendedCommand` and `notes`). It refuses `--environment` and
`--pairing-code`: it always reads from this computer.

**Older runtimes in the view.** A reachable runtime without the capability is still useful: its
own `accounts.list {refreshUsage: true}` rows (bounded like readiness) are classified with
`chooseVerifiedLaunchAccount`, aged on that host's clock (`accountCapacity.builtAt` plus the round
trip, so clock skew never makes a reading fresher), shown read-only, and marked "launch needs
OmniConsole update (no agent-session.verified-account-launch.v1)". It is never launchable. Its
load is `unknown`: `sessionHost.hostStats` needs a session-host declaration the CLI does not make.
SSH routes through an older runtime on this computer are listed but not read.

## Vocabulary

Launch outcomes use the execution vocabulary of `docs/reference/ssh-execution-boundary.md`:
`live` / `unverifiable` / `exited`, with no synonyms. A receipt proves the terminal was created,
not that the provider started. Loss of contact after a send is `unverifiable`, never "not
started" and never `exited`.

## Mixed versions

Wire details are in `docs/reference/remote-wire-compatibility.md` ("Verified account launch on
any host").

- A runtime without the capability (older app, orcad, a runtime without account services)
  refuses by name before anything is recorded or sent. Paired computers refuse until they run
  the release that carries this change.
- An explicit `--host ssh:<id>` against a runtime without the capability sends today's exact
  SSH payload: the pre-existing verified relay path. The receipt says the account was not
  reported, and its `launch` falls back to the requested model and effort with
  `source: "request"` when the host reports none.
- Old CLIs and `omni-launch-best` send only `ssh:` values; fingerprints are unchanged and the
  new result fields are ignored.
- `local` reaching an old runtime (capability check bypassed) fails its strict schema with
  `invalid_argument`, which is recorded as unverifiable, so the CLI never mints anew because of
  it.
- Placement skips a computer without the capability by name. A runtime that has the capability
  but predates the readiness `load` param refuses it with `invalid_argument`; the reader asks
  again without `load` and ranks its load as `unknown`.

## Where the code lives

| Concern                                          | File                                                                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Verdict, chooser, labels                         | `src/shared/account-launch-verdict.ts`                                                                              |
| Wire types and refusal codes                     | `src/shared/agent-launch-account.ts`                                                                                |
| Coded refusal (`agentLaunchRefusal`)             | `src/shared/agent-launch-account.ts` (re-exported by `agent-session-host-account.ts`)                               |
| Host dispatcher, Fable post-check                | `src/main/runtime/agent-session-host-account.ts`                                                                    |
| Local picker, preview                            | `src/main/runtime/agent-session-local-account.ts`                                                                   |
| WSL check                                        | `src/main/runtime/agent-launch-wsl-runtime.ts`                                                                      |
| Host name in local refusals (and session search) | `src/main/local-host-label.ts`                                                                                      |
| SSH picker (relay)                               | `src/main/runtime/agent-session-ssh-account.ts`                                                                     |
| Readiness (`AgentLaunchReadinessParamsSchema`)   | `src/main/runtime/agent-launch-readiness.ts`, `src/main/runtime/rpc/methods/agent-launch-readiness.ts`              |
| Host names                                       | `src/cli/launch-host-name.ts`                                                                                       |
| Record, intent                                   | `src/cli/session-launch-record.ts`, `src/cli/session-launch-intent.ts`                                              |
| Claim                                            | `src/cli/session-launch-claim.ts`                                                                                   |
| Input, plan, target                              | `src/cli/handlers/session-launch-input.ts`, `session-launch-plan.ts`, `session-launch-target.ts`                    |
| Send, outcome, supersede                         | `src/cli/handlers/session-launch-send.ts`                                                                           |
| Receipt, refusal texts                           | `src/cli/handlers/session-launch-receipt.ts`, `src/cli/session-launch-refusals.ts`                                  |
| Placement contract, rule v1 ranking              | `src/shared/agent-launch-placement-types.ts`, `src/shared/agent-launch-placement.ts`                                |
| Candidate reader (placement and capacity view)   | `src/cli/launch-candidate-reader.ts`, `launch-candidate-reads.ts`, `launch-candidate-state.ts`                      |
| Capacity view (`omni host list --capacity`)      | `src/cli/launch-capacity-host-list.ts`, `launch-capacity-view.ts`, `launch-capacity-format.ts`                      |
| Placement launch, freeze, refusals               | `src/cli/handlers/session-launch-placement.ts`, `session-launch-placement-plan.ts`, `src/cli/launch-placement-*.ts` |
| Readiness load and machine id                    | `src/main/runtime/agent-launch-load.ts`, `src/main/session-host-remote/host-resource-reader-runtime.ts`             |
