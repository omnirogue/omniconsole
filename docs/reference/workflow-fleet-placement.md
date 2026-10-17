# Workflow fleet placement

Where a workflow runs, how the host decides, and what it refuses. Every workflow preset runs
on the fleet by default; running on this computer is an explicit opt-in. The decision is
made once, at admission, and frozen into the run's snapshot as `host.placement`. One
exception: a Discover the fleet cannot take runs here instead (see below).

## When the fleet cannot take a Discover (2026-10-14)

Sal, 14 Oct 2026, answering "When the fleet Macs can't take a Discover you start in the app,
what should happen?": "Run it on this Mac instead". A Discover or Quick Discover left on the
fleet (no `--host`, no "Run on: <host>") whose placement or seat dispatch is refused is admitted
on this computer. Its placement is `{ runsOn: 'fleet', mode: 'local', fallback: '<the refusal>' }`,
the run header shows "Runs on this computer: the fleet could not take it (…)", and
`omni workflow run --json` and `omni workflow status` carry the same `fallback`. Typical reasons:
no fleet host with verified spare capacity, Grok or Gemini seats (dispatched seats run only
Claude and Codex), or a fleet host whose Claude is signed out. A host someone named is still
refused by name, and every other template is refused as before
(`local-workflow-host-admission.ts`, `FLEET_FALLBACK_TEMPLATES`).

## `runsOn`

`LocalWorkflowDraft.runsOn` is `'fleet' | 'local'` (`src/shared/local-workflow-placement.ts`).

- `createLocalWorkflowDraft` sets `'fleet'`; `workflowPresetRunsOn(kind)` answers `'fleet'`
  for every kind. The setup screen offers **Run on: fleet (default) / this computer** next
  to the access and Max agents controls; `omni workflow run` takes `--runs-on fleet|local`.
- Build + Review has the same choice: `BuildReviewStartRequest.runsOn`, a **Run on** row in
  its setup form, and `BuildReviewService` places every execution (a Start and a Retry
  alike) before the coordinator opens and before any worker starts. A refused fleet run
  fails with the refusal as its error and its last event; no `orchestration.workerStart`
  is ever issued for it. The placement is recorded on the pipeline as `placement`.
- Clients always send the field. `omni workflow run` sends `runsOn: 'fleet'` when
  `--runs-on` is unsaid, and the Build + Review form sends its selection, so a host from
  before placement (whose strict `workflow.run` schema lacks the field) rejects the request
  by name instead of running a fleet request on itself. The Build + Review `start` schema
  strips unknown keys, so an older host would run that request here; a client therefore asks
  `buildReview.placementSupport` first and refuses a fleet Start by name where the method is
  unknown (`method_not_found`), malformed, or unanswered within 5 s, so no host from before
  placement is ever sent one. Only a client from before this change can still send an older
  host a silent local run. The host answers the method statically; the guarantee that it
  places runs is that `BuildReviewService.execute` places every execution before the
  coordinator opens, and writes the placement to disk with a write that fails loudly: a
  write error is a named refusal ("The placement could not be recorded on disk …") and no
  coordinator or worker starts.
- A draft saved by an older build has no field: the host reads that as `'fleet'` for a new
  Start. Accepted call inputs stay frozen; explicit Retry may refresh automatic placement.
  Runs admitted before placement existed have no
  `host.placement` and replay as they ran, on this computer. A Build + Review run persisted
  before the field existed has no `runsOn` and retries on this computer for the same reason.
- Adding the field is a new optional field only (docs/reference/remote-wire-compatibility.md):
  no stream opcode, no changed request shape, and the Start RPC is local-only.

## The 60 percent rule

A host's spare capacity is its 1-minute load average divided by its cores. Under 0.6 it has
spare capacity; 0.6 to 0.8 halve fan-out; above 0.8 there is none. Placement counts only a
**fresh** reading under 0.6 on a **heavy-work** host as verified capacity, the same shape as
`chooseWorkflowRouteAccount` for accounts: the most spare (lowest load per core) wins, ties
by name, and with nothing verified there is no host. A run is never placed on a host whose
capacity was assumed.

Readings are `fresh` (a number, read now), `stale` (older than 60 s), `unknown` (no
reading), `saturated` (known busy, no number) or `unreachable` (the reading failed: a
refused connection, a timeout, a nonzero exit or output that does not parse). A failure is
never evidence about the host's processes; it only means the reading could not be taken.
Output parses only in the two exact shapes the load command prints, `24` then
`{ 3.58 4.34 5.73 }` on macOS or `16` then `0.52 0.60 0.55 1/1234 5678` on Linux; a
banner, an error line or an extra line is `unreachable`, so a stray number in an error
message can never read as an idle host.

## The hosts file

`OMNI_ESTATE_HOSTS_FILE`, default `~/Work/Ops/autonomy/canonical/hosts.json`, holds
`hosts[]` of `{ name, machine, hostname, ssh, role, heavy_ok, user, address, note }`.

- Only rows with `heavy_ok: true` are candidates; the primary Mac, laptop and the app VPS
  are `false` and are never read.
- `machine` dedupes capacity: two SSH aliases into one box are one pool of cores, and the
  first row names it.
- A missing file means no candidates (a fleet Start is then refused by name). An unreadable
  or non-JSON file is refused with the file's path.
- The row whose `hostname`, `machine` or `name` matches this computer's hostname (with or
  without `.local`) is read locally from `os.loadavg()[0] / os.cpus().length`; on Windows,
  which keeps no load average, that row reads `unknown` and never verifies. Every other
  row is read over `ssh -o BatchMode=yes -o ConnectTimeout=3 <ssh>` with one shell line
  that works on macOS and Linux: `sysctl -n hw.ncpu vm.loadavg 2>/dev/null || { nproc; cat
  /proc/loadavg; }`. All readings run in parallel, each bounded at 5 s, through
  `runProcess` from `src/shared/child-process/`.

## The three modes

`host.placement = { runsOn, host?: { name, machine, cores, loadPerCore, readAt }, mode }`.

| mode | when | what runs where |
| --- | --- | --- |
| `local` | `runsOn: 'local'`, or the fleet choice is this computer | everything here; a fleet choice records the host it verified |
| `remote-runtime` | the chosen host answers the runtime probe | the run is handed to the OmniConsole runtime on the host, which owns seats, accounts and the Check |
| `dispatched-seats` | the chosen host has no runtime with account services | seats and the Check run as dispatched sessions on the host's checkout; the controller stays on this computer |

The runtime probe is `ssh <alias> omni account list --json`, which calls that host's
runtime `accounts.list` and prints the CLI envelope (`src/cli/format.ts`). The probe passes
only on the success envelope with exit 0, `{ id, ok: true, result: { claude, codex,
rateLimits }, _meta }`: `parseWorkflowFleetRuntimeProbe` reads `result`, never the top
level. A runtime without account services prints `{ ok: false, error: { code:
'runtime_error', message: 'Account services are not configured on this runtime' } }` and
exits 1 (what the plain-Node `orcad` on mw0002 answers today), so that host is
`dispatched-seats`. The probe needs `omni` on the non-interactive SSH PATH.

`local` runs as before. `dispatched-seats` runs (below). `remote-runtime` is still refused by
name before anything is written: the placement is decided and carried on the refusal
(`WorkflowFleetPlacementRefusal.placement`, not persisted); a retried Start reads the fleet
again. Nothing ever falls back to this computer silently.

## Choosing the computer

The 60 percent chooser stays the default. A person may name the host instead: **Run on:
<host>** in the workflow setup form and in the Build + Review form (the heavy-work rows of the
hosts file, from `localWorkflow.fleetHosts`; no reading is taken until Start), or `omni workflow
run --host <name>`. The draft carries `runsOnHost` (and, from the form, `runsOnHostId`: `local`
for this computer, or `ssh:<target-id>` when an SSH target's alias or host is exactly the row's
SSH name at pick time; nothing is stored beyond the run's own record).

A named host (`placeLocalWorkflow(runsOn, deps, pick)`, "as named") must be a heavy-work row of
the hosts file (matched by name, machine, hostname or SSH alias), and is read fresh like any other.
It takes the run up to **0.8 load per core** (`WORKFLOW_FLEET_NAMED_MAX_LOAD_PER_CORE`), above the
auto chooser's 0.6; above 0.8 it is refused by name unless a person forces it with a reason
(`--force-host <reason>`, recorded as `placement.forced`). An agent caller can never force a host.
A named host that is unreachable, stale or unknown is refused by name; `--runs-on local` with a
named host is refused. The placement records `choice: 'named'` and the picked `hostId`.

In the CLI, `workflow run` is exempt from the global `--host` execution-host resolution
(`hostFlagNamesFleetHost`, `src/cli/execution-host-flag.ts`): there `--host` names a fleet host and
the handler sends it as is. Before 30 Sep 2026 the CLI refused every fleet host name there
(`Invalid --host value: mw0001. Expected local, ssh:<target-id>, or runtime:<environment-id>.`).

A new Start schema field is strict (`localWorkflow.start`), so a host from before named hosts
rejects a named Start by name. Build + Review's `start` strips unknown keys, so its client
requires `buildReview.placementSupport` to answer `hosts: true` before sending `runsOnHost`.

## Dispatched seats

A run placed on another computer without account services runs as **dispatched seats**: the
controller (run service, ledger, attempts, receipts, verdicts) stays on the requesting runtime;
every model call, the Check included (a Council final check or any review step is an ordinary
seat call), runs on the host's own signed-in `claude` / `codex` CLI over the same
`ssh -o BatchMode=yes -o ConnectTimeout=3 <alias>` the placement reads over
(`workflowFleetSshArgs`), through `runProcess`. No second transport, no API keys, no OpenRouter.

**At admission** (`readyWorkflowFleetDispatch`, `workflow-fleet-dispatch.ts`), before anything is
persisted, and refused by name on any failure:

- Every seat is Claude or Codex. Grok, Gemini, OpenRouter and Ollama seats are refused ("Seats on <host>
  run Claude and Codex on its own subscription logins; …").
- A run with a command check (`repeat.check`, `find.check`, an Improve code change) is refused:
  that check runs in this computer's workspace and never moves silently.
- One SSH probe, with `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY` and
  `CODEX_API_KEY` unset first, reads the host's resolved home and OS, each CLI's version against
  `WORKFLOW_CLI_MINIMUM_VERSIONS`, `claude auth status` (logged in with `claude.ai` or a
  subscription token) and `codex login status` (only which kind of login is printed: an API-key
  line names part of the key and never leaves the host). An API-key login is refused.
- The run's folder is made at `~/.omni-fleet/workflow-runs/<id>/` (mode 700).
- A run that reads files gets a frozen copy of what the agents may read (the workspace root, or
  the run's context folder): the same exclusions as the context copy (credential names,
  `node_modules`, `.git`, links), at most 512 MB / 100,000 files, packed here, sent with `scp`
  over the same SSH, checked against its sha256 there and unpacked into `<run>/workspace`.
- `placement.host.ssh` (the alias) and `placement.dispatch = { root, home, hidden, workspace? }`
  are frozen with the run, so launches and replays never re-read the hosts file. `hidden` is the
  host's home and data roots outside it, which a Codex seat is denied as it is here.
- This computer's own preflight (its CLIs and accounts) is skipped: they are not used.

**Each attempt** (`launchWorkflowFleetSeats`, `workflow-fleet-seat-launch.ts`) runs one POSIX `sh`
script over SSH (whatever the account's login shell): an exclusive attempt folder
`<run>/attempts/<attemptId>`, the private files the CLI reads (schema, instructions), a Codex home
whose `auth.json` links the host's own login, API key variables unset, the pid recorded (every
step `exec`s, so it is the CLI's pid), and a host-side alarm a minute past the call's timeout.
The prompt goes over stdin. The argv is the one `buildWorkflowClaudeStreamArgs` /
`buildWorkflowCodexStreamArgs` build here, with the host's paths.

- The receipt is this computer's: `createWorkflowLocalProcessLaunch` records the SSH process in
  `launch.json`/`terminal.json` with `dispatch: { host, machine, directory }` added.
- Results come back through the same attested path: the stream is parsed as a local one, a
  Claude answer must come from the attempt's own session id and model, and a Codex seat's session
  log is copied home with `scp` so `attestNativeResult` reads it where it always does.
- Codex calls on one host share its login, so a call that could refresh it (rotating refresh
  tokens: two refreshes at once can sign the account out) takes it alone, as local runs do
  (`workflowCodexLoginRefreshesWithin`). Just before each Codex launch,
  `workflowFleetCodexLoginRefreshesWithin` (`workflow-fleet-codex-login.ts`) reads only the login's
  access expiry and last refresh on the host (perl's core JSON::PP; no token leaves it). A login
  due within the call's timeout plus 30 minutes, or one that cannot be read, takes the lock;
  otherwise the call runs at once. Every call runs in parallel up to the run's concurrency.
- A stopped or timed-out call also stops the CLI on the host (the pid file, `kill -TERM`).

**A lost host** (SSH exits 255) fails that call once the host confirms its seat exited.
Remaining steps use the results that survived; the call is not retried on the lost host.
Retry on an automatically placed failed run takes fresh fleet readings and excludes the previous
machine. A named host remains explicit. An unreachable host or a seat whose exit cannot be
confirmed closes admission and requires reconciliation before Resume or Retry; loss of contact
never proves exit. Stops send TERM, poll, then KILL and poll again. Interrupted-run recovery
checks the recorded remote attempt as well as its local SSH process.

Fleet admission tries verified candidates in capacity order, including readiness checks, before
Discover's last-resort fallback to this computer. Failed admission removes its remote copy.
Finished run folders are swept before admission: seven days or a 2 GiB retention budget, oldest
first. A run without a finished marker or with any live or unreadable seat pid is protected.

**Limits of this build.** Seats use each host's default CLI login, not a chosen account there.
Dispatched runs therefore skip spare local accounts and substitute across families. Build + Review
stays on this computer: its workers edit this workspace's files.

## Agents launching a workflow for a person

An agent may start a workflow only when a person asked it to. The host tells an agent caller the
way the JEV trials do (`isAgentRpcCaller`: the request carries a Dispatch capability or the
session's compatibility evidence; the CLI sends that evidence on `localWorkflow.run`,
`localWorkflow.start` and `buildReview.start`). For an agent caller:

- the workflow must be agent-launchable (`WORKFLOW_AGENT_LAUNCHABLE`,
  `src/shared/workflow-agent-launch.ts`): Council, Discover, Build + Review and Evolve
  (docs/reference/evolve-workflow.md); the three JEV trials and every other kind stay person-only;
- both `--requested-by "<person>"` and `--request "<their words>"` (`requestedBy`, `request`)
  must be non-empty;
- `--force-host` is refused.

A person (the desktop, or a plain terminal) needs no flags. The words are frozen into the run
snapshot as `host.requestedBy` / `host.request` and shown in the run view, `omni workflow
status` and the sidebar row's status (`LocalWorkflowChangedEvent.requestedBy`).

## What the CLI reports

- `omni workflow run … --json` prints `{ started: true, worktreeId, conversationId, executionId,
  state, placement, requestedBy?, request? }` with `--no-follow`, and the placement with the
  final result otherwise. A Start the host refused prints `{ started: false, template, reason }`
  and exits 1; a Start that went unanswered is an error, never reported as refused.
- `omni workflow status <run-id>` (`localWorkflow.runStatus`) reads the run without resuming it:
  state, placement, who asked, and each launched attempt with its host, its folder there and the
  session it answered in (Claude's is the attempt id; Codex's is the thread id).

## The row

The sidebar row shows the machine a run was placed on as a caption, as fleet dispatch rows show
`run.machine` (`LocalWorkflowChangedEvent.host`; Build + Review rows read `placement.host.name`).
The run's host scope (`session-host-scope.ts`) is unchanged: a run is still filed under the
workspace it was started from.

## What `remote-runtime` still needs

Handing a run to a host whose runtime has account services is not a small delta, so it keeps its
refusal. It needs: (1) a start RPC on that runtime that admits a frozen snapshot (placement,
seats, context) it did not prepare, with its own owner and fence; (2) the frozen context copied
there first (the dispatched-seats copy can be reused); (3) the requesting runtime following that
run's view and receipts remotely (a watch over the paired or SSH-relayed runtime connection,
capability-negotiated per docs/reference/remote-wire-compatibility.md) instead of its own ledger;
and (4) a reachable runtime on the host: every fleet Mac today answers the probe from plain-Node
`orcad` without account services (below), so no host is `remote-runtime` yet.

## The refusal texts

- No verified host: `No fleet host has verified spare capacity (mw0002: unreachable,
  mw0003: stale, mw0004: 0.85 load per core, demo-claude: unknown). Choose 'this computer'
  to run here.` With no hosts file: `(no fleet hosts in <path>)`.
- A named host: `No fleet host is named <name> in <path> (heavy-work hosts: …).`, `<host> cannot
  take this run (unreachable | stale | unknown | not a heavy-work host). Choose another host, the
  fleet, or 'this computer'.`, `<host> is too busy for this run (0.91 load per core, over 0.8).
  Choose another host, or force it with a reason.`
- `remote-runtime`: `<host> runs an OmniConsole runtime with account services, but this
  build cannot hand a workflow to it yet. Choose 'this computer' to run here.`
- Build + Review on another computer: `Build + Review workers edit this workspace's files, so
  they cannot run as dispatched seats on <host> in this build. Choose 'this computer' to run
  here.`
- Dispatch readiness: the seat families, the command check, each CLI's install, version and
  login by name (for example `Claude is not signed in on mw0004 (claude auth status reports no
  login over SSH).`), the run folder, and the workspace copy (size, `scp`, digest, unpack).

A refused Start returns `{ rejected: true, reason }` like every other admission refusal:
nothing is written, the context copy is discarded, and the setup shows the reason.

## What a remote host must have

- A row in the hosts file with `heavy_ok: true` and a working SSH alias that accepts
  `BatchMode=yes` (key auth, no prompt) within 3 s.
- Spare capacity by the 60 percent rule at the moment of the Start.
- For `remote-runtime`: an OmniConsole runtime with account services (a desktop, or a
  desktop in `--serve` mode) and `omni` on the SSH PATH. **The plain-Node `orcad` runtime
  has no account services in this build**: `src/main/orcad/orcad-entry.ts` never calls
  `setAccountServices`, `requireAccountServices()` throws there, and every orcad host is
  `dispatched-seats`. `createRuntimeAccountServices`
  (`src/main/claude-accounts/runtime-account-services.ts`) builds them for the desktop and
  `--serve`; importing it from orcad pulls eleven `electron`-importing modules into the
  runtime graph, which `config/scripts/check-runtime-electron-ratchet.mjs` refuses, and the
  ratchet is a release rule that takes no exceptions. What lands it is porting each module
  to a host port in `src/main/host/`:
  - `app.getPath('userData')` → `getAppEnvironment().getPath('userData')`: the Claude
    managed-auth path and runtime-auth file storage, the Codex managed-home path and the
    Codex runtime home service (two call sites in 2,468 lines).
  - `net.fetch` / `session.defaultSession` → the `MainHttpClient` port
    (`src/main/network/http-client.ts`): Claude OAuth refresh, the Gemini OAuth sources and
    the Gemini usage fetcher.
  - `safeStorage` → the `SecretStore` port (`src/shared/secret-store`): the MiniMax cookie
    store.
  - `app.getLocale()` → a locale on `AppEnvironment` (none today): main i18n.
  - `session.fromPartition` (a per-partition cookie jar) → a port that does not exist yet:
    the MiniMax request context and the OpenCode Go request session.
  - 62 test files under those folders mock `electron` and must be checked as each moves;
    the vitest host-ports setup already installs a fake `AppEnvironment` and `SecretStore`.
- For `dispatched-seats`: `claude` and/or `codex` on the non-interactive SSH PATH, at or above
  the workflow minimum versions, signed in with a subscription (not an API key) for the SSH
  account, and `perl`, `tar` and `shasum` or `sha256sum` (present on macOS and common Linux).
  On macOS, a Claude login kept only in the login keychain may not be readable over SSH; the
  probe then refuses the host by name (seen on mw0003 and mw0004, 30 Sep 2026).
