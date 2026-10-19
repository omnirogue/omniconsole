## Agent JEV rubric tools

Hosts advertise `jev.rubrics.v1` when the structured decision runtime is installed.
New CLI clients require it before `jev.rubrics.list`, `.save` or `.evaluate`; older
hosts produce an update-required error without a settings or model fallback. The
three strict methods are additive.
The selected runtime owns the shared UI rubric settings, credential and private
result store. Forwarded SSH/WSL shells send bounded JSON with `--input-stdin` and
cannot read host-local paths through the controller's CLI. No stream opcode changes.

`jev.request.v2` widens the strict `jev.request` recipe enum with `support_triage`,
`retrieval_review` and `lead_fit`. An older host's schema refuses them, so the CLI
checks the capability before sending one and reports an update-required error. The
reply's `storage` block is additive; an older host omits it and keeps no record.

`jev.records.v1` advertises the additive strict methods `jev.records.list`,
`jev.records.export` and `jev.outcome`. New CLI clients require it and tell the caller
to update an older runtime; they never read another store. `jev.records.export` pages
with an opaque cursor that names only the runtime's own ledger files. Rubric and request
replies add an optional `storage.ledger` field. `StructuredDecisionProvider.evaluate` takes
an optional in-process `call` tag, which never crosses the wire.

# Remote wire compatibility

## Review wake copies (OAOS-12 Phase 2)

The desktop calls OmniOS's wake-copy routes (`/v1/artifacts/{slug}/wake-copy`, `.../parts/{n}`,
`.../complete`, `.../wake-claim`, `/v1/artifacts/wake-candidates`; CONTRACT.md). Each may be
absent on a live OmniOS: 404 without a code or 405 makes the desktop record `not available yet`
and leave OmniOS alone for 30 minutes, which is exactly Phase 1's behaviour. Nothing here crosses a
paired or SSH transport; `forgetSleptPane` is a request main sends only to its own window. The
session host journal gains `wake-claim:<slug>:<decision>` grants, readable by any version that reads
relinquishments.

## Review waits in Work and on OmniOS

`artifacts.reviewWaits` is a local, parameterless read for the window's Work tab; it never crosses a
paired or SSH transport. The desktop calls two OmniOS endpoints added with this release:
`POST /v1/artifacts/source-heartbeat` and `POST /v1/artifacts/{slug}/source-state` (desktop sign-in,
owner only). A live OmniOS without them answers 404 without a code or 405; the desktop then stops
asking for 30 minutes and its Work tab shows only this computer's waits. Inbox items gain an
optional `sourceState`, which an older desktop ignores and this one reads only when present.

## Hosted Evolve starts on Omnisi Cloud

`POST /api/evolve/runs` sends `usd_cap` only when the person set a cap, and lowers a larger
`spec.budget.max_cost_cents` to it, because omnisi-evolve-service admits the spec budget before
`usd_cap`. Its `CreateRunBody` refuses unknown fields, but `usd_cap` shipped in the same service
release (omnidots-cloud #89) as `execution_tier`, which every hosted start already sends, so no
service that accepts a start today refuses the cap. The service has no cancel route: Stop refuses a
hosted run by name. A start with no confirmed answer (timeout, 5xx, unreadable 2xx) reads
`unverifiable`, never `failed`, because the run may exist and be spending. Nothing here crosses a
paired or SSH transport.

## Peer session inventory ownership

On desktop restart, the initial full inventory also retracts unchanged restored
mirror workspaces omitted by their explicit owner, but only with the scoped
absence evidence below (`authoritative: true`, or `coverage` that leaves the
workspace outside its unverified scope); an omission without it keeps the rows,
labelled "can't verify". New host frames, local terminals and in-flight client
edits take precedence. These retractions are visibility facts, not process-exit
evidence or permission to resume an agent.

## Scoped absence authority (session counts, step 6)

A mirrored row leaves a receiver only on owner evidence scoped to it: complete
inventory coverage for an omitted workspace, complete workspace membership for
an omitted tab, or an explicit removal frame (`removed: true`). Two additive,
negotiated fields carry it. A client that advertises
`session-tabs.scoped-absence.v1` (every current remote transport does) receives:

- on a full inventory (`session.tabs.listAll`, the `snapshots` event of
  `session.tabs.subscribeAll`), `coverage: { unverifiedRepoIds, unverifiedWorkspaces }`
  when the owner's publication was current but its PTY census missed some
  execution hosts. Every omitted workspace is confirmed absent except any
  worktree of a listed repo or a listed workspace key. A complete census still
  sends `authoritative: true` and no `coverage`, exactly as before;
- on any per-workspace snapshot (list, listAll, both subscriptions),
  `membershipUnverified: true` when that workspace runs on a host the owner's
  last census could not ask, on every workspace before the first census settles
  or while the census times out, and on the unpublished placeholder. A workspace
  that becomes verified is re-minted (a newer version) once the verdict has held
  for a few seconds, so a flapping relay causes no version burst; going
  unverified needs no re-mint because every later frame carries the marker.

Census completeness is therefore scoped to the execution host: one offline SSH
host makes only its own workspaces unverifiable, and a confirmed local close
still retracts. A caller activating a row the owner no longer lists gets the
retryable `session_tab_unverifiable` refusal, not `tab_not_found`, while that
row's host is unverified. The owner strips both fields for a client that did not
advertise the capability, so mobile and older desktops see today's projection.

Receivers read missing evidence as unknown. An inventory without `authoritative`
or `coverage` (an older owner, or a stripped label) retracts nothing it omits;
the unpublished placeholder and a `membershipUnverified` frame add and update
the rows they list but drop none. The placeholder is recognised by its base
epoch, whatever its version: every paired client has a device id, so the owner's
per-device navigation projection delivers it as `none:client-navigation` at
version 0 plus that device's selection revision (older owners included). The
same reading backs the browser client-hosted carve-out. A real, versioned
per-workspace publication from an older owner remains its membership evidence,
as it was. Rows kept this way (terminals and structured chats) are labelled
"can't verify", are never woken (the resume sweep treats them as undecidable, a
wake respawn needs membership evidence, and a mounted pane is never told its
surface is gone), and are replaced as soon as a later frame lists them again or
proves them gone. Mirror removal never implies process exit.

Rollout: upgrade owners before receivers. A new receiver paired with an old
owner that has an offline SSH host (or whose census is incomplete for any reason)
gets no `coverage`, so it keeps rows that owner closed as "can't verify" until
the owner is upgraded or its census completes.

Desktop and headless session inventories exclude workspaces owned by a paired
runtime and web terminal mirrors with only remote PTYs or no binding. Legacy
web-prefixed tabs backed by local PTYs and direct SSH sessions still publish.
This prevents paired computers from republishing one another's inventories under
their own identity. The wire schema and capabilities are unchanged. An inventory
omission retracts a mirror's visibility; it never proves process exit or stops the
peer's session. Persisted conversations remain intact.

One shared rule (`src/shared/session-inventory-ownership.ts`) decides this for the
desktop publication and every runtime path (list, listAll, both subscriptions,
headless hydration). Inside an owned workspace, a tab with per-tab peer provenance
(a unified tab stamped `runtime:*`, a remote-runtime PTY, a web-terminal mirror or
a mirrored editor) is not published; conflicting provenance stays visible locally
but is never republished. Missing metadata still means local.

Receivers bucket mirrors by (environment, workspace): a frame replaces or removes
only rows whose own evidence names its environment, and a frame for a workspace
the saved catalog credits to another paired environment is ignored, counted and
parked for replay if the catalog or a same-host pairing proof later credits its
environment. Ownership is read from saved records only, never from the host a
window has open. Owner qualification is client-local; an identical host tab id
from a second owner gets an owner-qualified client id, and every RPC still sends
the host's own tab id. Old publishers' echoes are therefore rejected without a
wire change. Rows of an environment removed from the saved list are retracted in
the same turn; a same-id re-pair keeps them for its republication.

After a headless runtime opens its desktop, the renderer's published tabs replace
ordinary persisted terminal rows. Genuine runtime-owned and serve/SSH bindings
keep their existing preservation rules; an old headless epoch alone cannot retain
a tab omitted by the desktop. No persisted state or process is deleted.

## Session inventory ordering (step 3)

A host stamps every session-tab snapshot and removal frame with `inventoryOrder`: its runtime
`generation` (one per incarnation, opaque), one `revision` shared by every
writer of its stored inventory and by removal tombstones, and the receiving client's own
`projectionRevision` (navigation and closed tabs). It sends the field only to a client that declares
`session-tabs.inventory-order.v1` (the host also advertises it), independently of step 6's
`session-tabs.scoped-absence.v1` (each field is stripped for a client without its own capability);
list, listAll, both subscriptions
and mutation replies apply one projection, so a client gets the same frame on every path. An older
client sees exactly today's frame, epoch and folded version. A new client orders an owner's frames
within a generation by revision, then projection revision, in its arrival gates (latest received,
recovery supersession) as well as its decision. Generations are never compared (an owner's clock can
step backwards): any unretired one is accepted, and the one it replaced is retired once the new one
arrives on a fresh connection. The client fences retired generations, delayed list responses and
frames older than a removal it applied. It keeps today's epoch/version ordering for any frame without
the field, and never orders the unpublished placeholder (step 6's recognizer) or a removal it
synthesized (`visibility-inventory-removal`, `environment-retired`); those stay on step 6's
removal/unknown path. A frame whose membership is unverified is ordered like any owner frame, and
step 6 still decides what its omissions mean. The host also refuses a graph from a
renderer generation that a newer one replaced, and removing a worktree now sends its removal frame.

While a desktop window is the authority, its accepted publication decides the surfaces it lists:
runtime reconcilers (headless browser reconcile, headless hydration, listAll repair, live-terminal
restore) only add or remove runtime-owned surfaces and keep the window's base epoch; that authority
ends when the window closes and applies only to the current renderer generation's publication. A
headless host starts recovering its persisted and live inventory before its first graph publication
and advertises a complete inventory only once the latest recovery run settles (likewise after a
desktop window hands back to headless); its RPC server is not held back, and reads wait for a pending
run (bounded) and still repair on read, so they never get a synthesized authoritative empty
inventory. While repair-on-read stays, list/listAll/activate/close repairs run outside the
serialized recovery (their PTY census is coalesced). Persistence changes, PTY spawn/exit and
execution-host reconnect are not recovery triggers: PTY lifecycle publishes or retires its own
surfaces, and host reconnect has its own fenced republication. No params, opcodes or persisted state
change.

## Controller-owned workflow records (session counts, step 9)

Workflow conversations (Council, Discover, Evolve, Build + Review …) are anchor tabs with no
pane, so terminal-leaf publication never carried them and a paired computer's group for an owner
counted a different population than the owner's own list. A client that advertises
`session-tabs.workflow-records.v1` (every current remote transport does; owners list it in
`status.capabilities`) receives the controller's whole workflow set as one ordered value:
`{ generation, revision, complete, recordsByWorktree }`, each record `{ tabId, preset, title,
status, runId, phase?, host?, origin?, archived? }`. It rides as an additive `workflowRecords`
field on `session.tabs.listAll` and on the `snapshots` event of `session.tabs.subscribeAll`; every
later change is one negotiated `{ type: 'workflowRecords', ... }` event on that stream (a new event
type, sent only to a client that advertised the capability). Between two complete sets the event is
a delta, `{ generation, revision, baseRevision, complete: true, changedByWorktree }`, carrying only
each changed workspace's whole list (`[]` when none is left) against the revision that stream last
delivered; a completeness change resends the whole set. A set is capped at 5000 records (500 per
workspace, 2000 workspaces); a capped or malformed set is incomplete. `status` is step 8's outcome
vocabulary (draft, starting, running, needs-you, done, failed, stopped, run not found = `missing`,
status unavailable = `unavailable`, `unknown`); `archived` is the controller's own archive mark.

- Only the controller publishes, from its own window (`runtime:syncSessionWorkflowRecords`, a
  window-to-own-main IPC that never crosses a transport, accepted only from the renderer
  generation whose graph main holds; a refused send retries at once when the graph sync lands,
  else with bounded backoff). Every workflow anchor in that window's tabs is published, including
  one it runs in a workspace a paired computer owns: the run is this controller's. A receiver
  keeps mirrored records outside its tabs, so it never republishes a peer's. Identity is the anchor
  tab under its controller; `runId` is the run address.
- The set orders by its own `generation` (one per runtime incarnation) and `revision`, which moves
  on every change to the set or its completeness, so a removal and a re-addition are each newer and
  a late copy (a delayed listAll) can never restore what a newer set removed. A receiver takes a
  new generation only from a set that opens a stream: the initial listAll or any `subscribeAll`
  inventory, including the one replayed after a reconnect (a restarted owner); that retires the old
  generation, whose late sets stay fenced. A different generation in a later event is ignored. A
  delta applies only on a complete state of its generation at least as new as its base.
- A workflow belongs to the window that runs it, so its removal is judged from the controller's
  complete set alone: no terminal removal frame, process census (`membershipUnverified`) or
  workspace omission removes one. `complete` is true only while the window that published the whole
  set is attached and restored its sessions; at startup, headless, after the window closes or a
  reload fails, after a degraded startup, or when a record was malformed or over the cap, the set is
  incomplete and adds and updates but removes nothing.
- Receivers reconcile into owner-qualified (environment, workspace) buckets and count each record
  under its controller, and the controller counts its own workflow rows under itself too (whatever
  host the workspace runs on), so both computers group a workflow alike; identity and archive keys
  are unchanged. The controller's archive mark is read-only on the receiver (sidebar and `omni
  session list`). Activation calls `session.workflows.open` `{ worktree, tabId }` on the controller,
  which opens it visibly in its own window (never a terminal or a run); it refuses with
  `session_workflow_not_found` when its complete set omits the tab and the retryable
  `session_workflow_unverifiable` when it has no window or no complete set.

The owner adds nothing for a client that did not advertise the capability (no field, no event), so
mobile and older desktops get today's projection exactly. A new receiver facing an older owner gets
no set and shows nothing new. If an owner that sent sets answers a fresh connection with none (it
was downgraded), its mirrored rows stay listed but read "status unavailable" until it sends a set
again. Rollout: either order works; workflows appear on a receiver once both sides are upgraded.

## Owner conversation ledger (session parity)

A paired computer's group for an owner listed a different population than the owner's own sidebar:
dormant and tab-less (slept) conversations, the owner's archive marks, folders and projects never
crossed, so "archive it here" showed nothing there. A client that advertises
`session-tabs.conversation-ledger.v1` (an owner names it in `status.capabilities` only while its
owner ledger publisher runs — a desktop owner, never orcad, which publishes none — and a receiver
treats an owner that does not name it as an older owner whatever the field holds, since a
negotiated orcad still fills it with an empty revision-0 set; a revision-0 set from any owner is
read as no ledger yet, and the owner's first publication then arrives as a delta on base 0, which
the receiver takes as the whole set; it is not in `RUNTIME_CAPABILITIES`;
clients declare it through `remoteRuntimeClientCapabilities` together with the receiver that
consumes it, Phase 1b) receives the owner's conversation ledger as one ordered value,
`{ generation, revision, source, listedAt, coverage, omitted, truncatedWorktrees?, folders,
projects, recordsByWorktree, removals, removalsTruncated? }`, as an additive `conversationLedger`
field on `session.tabs.listAll` and on the `snapshots` event of `session.tabs.subscribeAll`; every
later change is one negotiated `{ type: 'conversationLedger', ... }` event on that stream — a whole
set, or between two sets a delta `{ generation, revision, baseRevision, source, coverage,
changedByWorktree, folders?, projects?, removals?, removalsTruncated? }` carrying each changed
workspace's whole list (`[]` when none is left) against the revision that stream last delivered.
Contract and lenient readers: `src/shared/session-conversation-ledger.ts`.

- Record: `{ conversation, paneIdentity?, agent, providerSession: { key, id } | null, title (≤200),
  titleSource: 'custom' | 'terminal' | 'generated' | 'agent', surface: 'tab' | 'record', paneKey?,
  tabId?, rest: 'live' | 'dormant' | 'asleep' | 'unknown', interrupted?, archived?: { archived,
  byHand? }, folderId?: string | null, saved?, hidden?, listed, updatedAt }`. `conversation` is
  24 hex chars of sha256 over the owner's FULL claim key (`getProviderSessionClaimKey`:
  worktreeId, agent, provider key and id, and the transcript path for Pi and Prime Agent, whose
  conversations can share a session id across transcript files) — opaque on the wire, the path
  stays on the owner. A receiver computes the same digest from its own record's claim key
  (`sessionConversationIdentity` / `sessionConversationIdentityFromProviderKey`; a mirrored
  workspace reuses the owner's worktree id), folds and joins by comparing digests, and keeps a
  sent digest as is (the reader accepts a 24-hex value and never rebuilds or overwrites it). A
  capture whose digest matches no record but whose components match more than one record is
  ambiguous: kept separate and non-actionable, never merged. A provider-less
  tab record carries `paneIdentity: 'pane:<paneKey>'` and `conversation: null`. A `surface: 'tab'`
  record names the owner pane and tab so it joins the mirrored row of that tab; a `'record'` row
  has no pane on the receiver. `listed: false` marks passive completed-hibernation evidence the
  owner holds but does not list, so a receiver's own capture folds onto it instead of being
  retired. Organization state is tri-state: an explicit value — including `archived: false` and
  `folderId: null` (unfiled) — replaces what the receiver knew; an absent field leaves it.
- What never crosses: `prompt`, `launchConfig`, `agentArgs`, `agentEnv`, `transcriptPath`,
  `lastAssistantMessage`, and project settings (agent instructions, attachments) — `projects` is
  `{ folderId, displayName? }` only, `folders` is `{ id, name (≤80), parentId?, section? }`.
- Titles (addendum F2) are what #1081's `sessionTitle` already carries: the owner's sidebar label
  as is — a rename (`titleSource: 'custom'`), a pane or terminal title (`'terminal'`), or a title
  the app or the agent generated (`'generated'`: the owner's ≤40-char preview of the first prompt,
  or the agent's own session title, which can be its first user message, ≤96 chars). Only a row
  with no title of its own — a tab-less record the owner's sidebar names by its prompt, a
  "Terminal N" placeholder, or nothing — sends `title` = its agent's name (the `agent` value) with
  `titleSource: 'agent'`, and a receiver renders its own localized "<agent> (untitled)"; neither
  the prompt nor any text in the owner's language crosses. The readers pick known keys only, and
  their tests scan serialized values for a sentinel placed in a prompt, a launch config, a project
  setting, an attachment and a Pi transcript path, and pin that a generated title crosses while a
  prompt-only record sends its agent's name.
- Caps: 1000 records per workspace, 2000 workspaces, 8000 records in total, 500 folders, 500
  projects. A cut workspace is named in `truncatedWorktrees` and reads `complete: false`. A
  workspace whose id exceeds 1000 chars cannot cross: the owner leaves it out of the records and
  coverage and counts its rows in `omitted.unverified`, and a reader that rejects a bucket for its
  key adds that bucket's records to `omitted.unverified` too, so no total shrinks silently.
- Coverage is per workspace, never host-wide: `coverage[]` names every workspace the owner speaks
  for, and a workspace with a dropped, duplicate or cut record is incomplete whatever the owner
  said. `omitted: { unknownHost, unverified }` counts rows the owner's sidebar lists but the
  ledger leaves out (rows under no execution host; rows whose ownership the owner cannot verify),
  so no total reads smaller than the owner's.
- `source: 'window'` means the owner's window listed its sidebar; `'main'` means the owner
  rebuilt the ledger from its persisted store with no window (archive and folder as last listed).
  A new `generation` (an owner restart) restarts revision ordering and by itself removes nothing;
  removing a row or retiring a receiver's own capture needs `source: 'window'` and
  `coverage[worktreeId].complete === true` in a set received live on that connection, or a
  tombstone (below). A `main` set, an incomplete bucket, a delta bucket read incomplete and a
  snapshot restored from disk add, update and vouch; an ordinary omission from them removes
  nothing. Folders and projects on a delta ride only when they changed; absent means unchanged,
  never "none".
- Tombstones: `removals: Array<{ conversation? | paneIdentity? | workflowTabId?, worktreeId, at }>`
  — exactly one identity (the full-claim digest, `pane:<paneKey>` for a provider-less
  conversation, or a workflow's anchor tab id), the workspace, and `at`: the deletion time in epoch
  ms, or, for a tombstone the owner held back while the conversation was listed again (below) and
  shows again once it is not, that later moment. Main authors every one from the owner's durable
  deleted state (an undo clears it) and keeps each for 90 days from its `at`, however old the
  deletion; a set carries the retained list (newest 2000 by `at`, `removalsTruncated` when cut), a
  delta every removal first published after its `baseRevision`, and the window's own publication
  to its main none. A
  tombstone removes the row and its capture whatever the set's source or coverage; a receiver
  matches it by `sessionConversationRemovalKey` (identity kind + value + workspace). An entry with
  no identity, more than one, no workspace or a non-finite `at` is dropped. A receiver that sees
  `removalsTruncated` (or reconnects after the retention window) removes nothing by inference.
  Listed evidence wins: no set tombstones a conversation it lists by either identity (a deleted
  conversation whose tab is open again); the owner holds that tombstone back
  (`sessionConversationListedRemovalKeys`) and, once the row goes, publishes it again as new, so the
  next delta carries it. Withdrawing a published tombstone (an undo or a reopened tab) resends the
  whole set, since a delta only adds removals. Nor does an owner show any tombstone (or
  `removalsTruncated`) before its runtime incarnation publishes its first set, window or main (the
  set it kept on disk does not count); that set releases them, stamped at its revision.
- The owner adds nothing for a client that did not advertise the capability: no field, no event,
  frames byte-identical to today. A new receiver facing an older owner gets no set and keeps
  today's "can't verify" rows. Rollout: either order works; the tab surfaces the ledger decorates
  reach a receiver on the existing frames since PR #1084 (see "Dormant and untabbed terminals on
  existing frames" below).
- Receiver (Phase 1b, `web-session-conversation-ledger.ts`): one bucket per owner environment and
  workspace (never merged across owners), reconciled by tagged identity (`c:<digest>` or
  `p:<paneIdentity>`; a provider-less pane's row gives way to the same pane once it names its
  session). Sets and deltas are ordered as workflow sets are (a new generation only from a fresh
  connection, old ones fenced) but a new generation removes nothing: a workspace is replaced whole
  only by a live `source: 'window'` set or delta with complete coverage for it; anything else
  adds and updates. Tombstones in sets and deltas remove matching rows (by digest or pane) unless
  the same message lists them, and a `workflowTabId` tombstone hides that mirrored workflow for as
  long as the owner keeps it. `removalsTruncated`, or a reconnect more than 90 days after the last
  evidence, marks every bucket the message does not replace whole unverified. Per-owner state:
  `ready`, `stale` (restored from disk), `older` (a fresh answer without a ledger; rows kept),
  `unreachable` (its runtime stopped answering; rows kept). After every applied set or delta the
  window sends its reconciled view to its own main (`runtime:rememberConversationLedger`), kept at
  `<userData>/session-host/ledgers/<environmentId>.json` with the owner's journal hostId and its
  workflow records; on start the window reads them (`sessionHosts.ledgerSnapshots`, window-only)
  and lists them `stale`, "as of" the time it last heard the owner. A snapshot never stands for an
  absence and its restoration removes nothing.

## Caller activation needs positive ownership

`session.tabs.activate` from a non-host caller (`navigation` `caller`/`clients`, which every
paired runtime or phone resolves to) starts a process only with positive ownership: the owner's
current publication lists the exact tab/leaf, or a serve/SSH or live runtime-owned binding exists.
With a window attached, its complete publication decides: a listed surface that is not running is
mounted by that window, which acknowledges the exact surface (main ↔ window IPC, one build) — even
when a serve/SSH binding exists — and a failed mount is reported, never replaced by a background
PTY; a workspace or tab the complete publication omits is `tab_not_found`. With no window (headless,
or a desktop whose window closed while the app runs) the persisted session is the record and must
list the exact tab and leaf; the PTY then starts for the window to adopt on reopen. A live
runtime-owned binding is attached, never recreated. Authority is rechecked after launch resolution,
before spawn and after the agent admission gate. While the window is starting, reloading or still
publishing, a new coded refusal, `session_tab_unverifiable` (or `session_tab_mount_failed`), carries
`data.retryable` and a readable message; the RPC entry applies it before its missing-row check, and
capability-hidden rows stay `tab_not_found`. No params or capabilities change. New clients keep the
pane and keep polling within their 15 s wait, then park a retry; an older client sees an ordinary
coded failure (not "closed") and starts nothing. Host-targeted activation is unchanged.

`sessionManage.list` entries gain an optional `placement: 'background-not-in-window'` for
runtime-owned terminals no window tab shows, and `scope.backgroundTerminals`; `sessionManage.tidy`
keeps those rows under the `background-not-in-window` group unless `--delete --include` names one,
which is re-checked at apply time and ended through the audited `terminal.close` path with the
run's reason and request recorded. These methods are local-CLI only. The owner's Conversations
sidebar reads the same list over a window-only IPC channel (`runtime:listBackgroundTerminals`, never
a peer) and offers Open (`terminal.focus`, host navigation) and a confirmed End
(`runtime:endBackgroundTerminal`: re-checked, closed through the `terminal.close` path, audited).

## Review summary and options

`artifacts.share`, `artifacts.publish` and `artifacts.update` accept three optional `review` keys
that OmniOS already validates (`artifact_reviews.normalize_review`): `summary`, `options`
(2 to 8 `{label, detail?, recommended?: true}`) and `multi: true`. The desktop forwards `review`
unchanged. An older desktop's strict `review` schema refuses them, so the CLI's `--summary`,
`--option`, `--recommend` and `--multi` fail there instead of being dropped; without those flags
the request is unchanged. No stream opcode changes. Over SSH the relay skips the values of
`--summary`, `--option` and `--recommend` when it finds the file; an older relay takes a value
placed before the file for the file, so put the file first there.

## Review sleep notice

`artifacts.share`, `artifacts.publish` and `artifacts.update` accept an optional local
`keepSession` boolean and add an optional `sessionSleep` notice to a successful reply
(`armed` with `liveMinutes`, `kept`, or `unavailable` with a reason). Older CLIs ignore the
notice; an older desktop's non-strict schema drops `keepSession`, so the session follows that
desktop's behaviour. `artifacts.reviewSleepTargets` is a local, parameterless read the window's
hibernation timer makes of its own host; it never crosses a paired or SSH transport. Nothing is
sent to OmniOS, and no stream opcode changes.

The window's `deleteSession` organization op gains an optional `purge` (close without a Recently
closed entry). Only this desktop's main process sends it, to its own window of the same build, for a
review Reject; the CLI never sends it, so a paired or older window never receives it. The same
holds for `listSessions`' optional `requireReady` and the `paneParkedBySleep` request.

## Generic launch source evidence

The CLI now carries its existing optional `orchestrationCompatibilityEvidence` envelope
on `terminal.createAgentSession` when caller evidence exists. Ordinary launches with no
source evidence keep their existing request. No parameter schema, capability or stream
opcode changes. Older hosts may ignore this optional envelope.

The existing host launch-cause adapter records the pane and terminal as **unverified**
claims and never stores the launch token in the ledger. This propagation alone grants no
worker ownership, trusted parent, completion mailbox or automatic cleanup authority.
Those remain bound to the host's existing orchestration registration and accepted-result
contracts; generic launches without that registration remain retained conversations.

## Passive terminal activation holds

Pending `session.tabs.list` / `session.tabs.activate` terminal snapshots may include
`automaticActivationHold: 'completed' | 'parked'`. The owner derives it from the exact
workspace/pane checkpoint used by automatic materialization admission, and omits it
when a live terminal handle exists. It names an intentional cold-start hold, not process
exit or transport failure. Paired clients show Resume and do not run an outage retry
for that hold; Resume uses the existing exact-leaf user activation path once. An
unconfirmed wake receipt never licenses repeating the user activation.

Older owners omit the field and keep the existing pending-handle recovery behavior.
Older readers ignore it; unknown future values do not establish a hold. No RPC request
schema, terminal status, capability requirement or stream opcode changes.

## Dormant and untabbed terminals on existing frames (PR #1084, Rule 3)

Since PR #1084 an owner publishes every terminal surface its persisted workspace session
holds — dormant ones (no live PTY) and ones outside the tab strip
(`persistedTerminalMembershipHoldsSurface`) — on the existing `session.tabs` frames with no
capability gate: a Rule 3 change, checked as Phase 0 exit criterion (c) of the session-parity
plan. On the wire such a surface takes the pending-handle shape clients have read since at least
v1.12.21 (the current cross-version baseline): `{ status: 'pending-handle', terminal: null,
automaticActivationHold? }` (`RuntimeMobileSessionTerminalClientTab`). A receiver on that
baseline treats it as a terminal surface (`isTerminalSurfaceTab` is `type === 'terminal'`) and
builds a mirror tab with `ptyId: null`, because only a `status: 'ready'` surface binds a PTY
(`web-session-tabs-sync.ts`, the `ptyIdsByLeafId` filter, unchanged since the baseline); it
creates no sleeping record, sets no spawn intent and asks the owner nothing about a listed
surface (the orphan census only concerns PTYs a frame omits). A sidebar row appears only when
the surface names its agent (`buildSidebarSessions` keeps its `providerAgent` guard on both
builds), so the receiver's count for that owner rises by those surfaces. The one path that
materializes a pending-handle surface is `session.tabs.activate` from a terminal pane the person
opens (`remote-runtime-pty-transport.ts`: "pending host surfaces materialize only through
activation"), and the owner's `automaticActivationHold` already pauses it for completed and
parked checkpoints — the same behavior those rows had before #1084, only more of them. An older
receiver therefore shows them as inert pending-handle rows and never wakes or launches them; no
`session-tabs.dormant-surfaces.v1` gate is needed. The cross-version harness
(`tests/e2e/cross-version-wire/`) loads a baseline's RPC host, protocol constants and terminal
multiplexer but not its session-tabs receiver, so the receiver side is pinned by
`src/renderer/src/runtime/web-session-tabs-sync-mirror-records.test.ts` ("a dormant or untabbed
owner surface without a PTY") on current code plus the baseline source read above.

## Paired question answers

`session-question.owner-answer.v1` advertises the additive `sessionQuestion.read`
and `sessionQuestion.answer` RPCs while this host permits remote controls. Only
an authenticated paired runtime UI that declared the capability may use them;
the host retains its paired-device principal as a remote person, never a local
CLI actor. Local sockets, mobile clients and dispatched workers are refused.

The read binds the exact runtime, workspace, pane, terminal incarnation, fresh
provider identity and single displayed question without adopting sessions or
creating a persistent ticket. Its reply supplies the question/options the UI
renders and an owner fingerprint over the complete guarded prompt and execution
process and tool-call occurrence (or a Codex async question's explicit asking time).
Missing occurrence evidence refuses; an OSC row never borrows an older HTTP
report's provider identity. An answer must repeat that binding; the owner rechecks it before each
write through the existing guarded answer engine and shared quarantine. Missing
or changed evidence refuses. A lost or unconfirmed receipt is never resent.

The live-hook projection gains optional provider key/id and agent type from its
same fresh report, without resume-identity fallback. Existing readers ignore
these fields. Older hosts lack the capability/method: clients offer Open in
conversation, with no local or raw-terminal answer fallback. There is no new
stream opcode.

## Corpus audit workflow

`localWorkflow.setup` adds optional `auditSupport` and `auditTeam`. The Audit form requires the
versioned support acknowledgement; absent support displays an update message. Other workflows
retain their existing setup behavior. `localWorkflow.start` accepts optional `draft.audit` on its
strict draft schema; older hosts refuse it instead of substituting Discover. The host captures
the selected corpus, never accepts a client snapshot, and refuses fleet or unproven execution
hosts before reading files. No method or stream opcode is added.

Run views add an optional `audit` marker while retaining ordinary stages, calls and report
fields, which older readers can render generically. A tab persists a Discover storage anchor
with its audit draft; old builds cannot launch it through current graph-only admission. Remote
corpus transfer remains unavailable.

## Folder terminal restoration

The host recognizes existing `folder:<id>@@<suffix>` daemon IDs during inventory,
including older daemons that omit the live cwd. A saved host tab group can select
its unique surface over exact ungrouped duplicates (web mirrors or stale host rows)
only when workspace, leaf, PTY and incarnation all match. Competing grouped surfaces
or missing group proof remain ambiguous. Saved rows are retained; no daemon process
or wire contract changes.
Older clients receive the existing host tab/pane identity in ordinary snapshots.

## Routine session ownership

`sessionManage.list` sidebar rows may include `routine: true` for sessions owned by
a routine. New owner-selection and assignment paths exclude those sessions. The
field is optional, so older windows can omit it and older readers ignore it;
omission retains the previous routing behavior. No RPC parameter or stream opcode
changes. Failed conversation-binding saves retain their resolved execution host
alongside the existing target and conversation identities for the next catalog sync.

## Session preparation project default

`sessionPrep.request` accepts optional top-level `defaultFolder`, the controller-local project
folder id captured from the requesting conversation. Its strict schema makes an older host refuse
the field instead of silently accepting a request it cannot file correctly. The batch persists the
id, and the controller resolves it by exact id for unnamed items; explicit item folders still win.
Project attachments are filtered for the actual execution host through the existing launch resolver.
The id is never interpreted as a private folder on another runtime. No stream opcode changes.

The existing `agentTemplateId` request field selects the project's saved copy through the existing
project-launch `templateId` field. That copy overrides the controller's global template text.
Prepared reuse records may retain optional `reusePrompt` with resolved project context for Assign;
the original prompt remains separate so Launch new resolves inheritance only once. Older records
without this field retain their original assignment prompt. No RPC schema or stream changes.

## Project thread listing

`sessionManage.list` accepts the optional `project` selector on its existing strict
schema. A new host asks its own desktop window for the resolved project folder;
that reply explicitly acknowledges the folder ID alongside the rows. An older
window returning an ordinary row array is refused with reload guidance, rather
than reported as an empty project. Unfiltered callers keep their row-array reply.
Project status fields are additive. Hosted-review signals stay scoped to the
thread's execution host; ambiguous remembered leaf-only worker links do not
establish project membership across host copies. No stream opcode changes.

## Worker outcome receipt reads

`orchestration.workerShow` accepts optional `receipt` and `observeProvider` fields.
The CLI requires `orchestration-worker-outcome-receipt-v1` before sending them;
older hosts can ignore unknown fields, so there is no fallback to ordinary show.
The receipt branch joins one existing Run, Task and Dispatch without lifecycle
reconciliation or new storage. Current task state is labeled separately from the
selected attempt and reports whether that Dispatch is still current.

Provider observation is opt-in and reuses the bounded, exact `workerRead`
transcript path on the execution owner. Missing methods, lost contact and missing
provider evidence leave actual model/effort unknown. Launch arguments are labeled
as resolved arguments, never provider observations. No stream opcode changes.

The receipt never calls the reconciling HUB board GET. A complete console-job
start binding permits one existing read-only task lifecycle GET, bounded by the
signed-person transport's 15-second timeout and 2 MiB response limit. Only exact
schema-1 Attempt/contract/dispatch/producer/candidate/report bindings can populate
the additive `hubEvidence.canonicalReports` field. Producer stints and reports
must be complete and non-degraded; oversized lists are refused, never truncated.
Older or malformed HUB projections remain unavailable without board fallback.
The observed state names historical report evidence, and its common reason field
remains readable by older receipt clients. No new RPC or stream opcode is needed.

Report verdicts, policy digests and independent verifier Session identities are
historical evidence, separate from the current task's contract/lifecycle fences.
They do not prove current acceptance under its effective policy. The optional
`outcome.currentAcceptance` records current acceptance only when the same lifecycle
response includes a non-degraded selector from HUB's existing
`canonical_current_task_verifications` view. Its task, Attempt, contract, candidate
and selected pass report must match the complete validated historical evidence.
HUB's view owns effective policy selection; the client does not duplicate its
acceptance SQL. A healthy null selector is `not_observed`; absent, malformed,
degraded or mismatched selectors are `unavailable`. Older receipt hosts omit this
field, which the CLI displays as unknown. A selected report retains view/report/
policy provenance and leaves independently accepted quality null as an unmeasured
score. Native execution refs stay opaque; candidate and
rendered-brief digests never substitute for the unobserved canonical input digest.
Elapsed record intervals are separate from phase durations;
queue, transfer, execution, retry, review, verification and costs remain null
until their respective evidence exists. New controller-managed worker starts
record a monotonic startup interval from Dispatch creation to acknowledged task
input in the existing start-options receipt. It includes setup, readiness and
prompt delivery, names its run-home clock, and is committed with the ready state.
Older, federated and canonical starts without that measurement remain null.

## Run queue summary

`orchestration.runShow` accepts optional `queue` and `limit` fields and then adds a `queue`
object to its reply. The CLI requires `orchestration.run-queue.v1` before sending them: an
older host strips the unknown fields and answers a plain show, which would read as an empty
queue, so there is no fallback. The summary joins the Run's unfinished Tasks to each newest
Dispatch without lifecycle reconciliation or new storage.

Session facts come from the execution owner and stay apart from the Dispatch record. A local
worker reuses the `workerShow` observation (`live` / `unverifiable` / `exited`, plus `missing`,
`identity_changed` and `unattached`) and its optional `agentWait`. A worker on a connected
server is read through the existing read-only `orchestration.federationShow`, bounded to 8
seconds; a server that does not answer, or reports a status this build does not know, is
`unverifiable`, never `exited`. `agentWait`, `agentState`, `providerLimited` and `lastOutputAt`
are each absent when not evaluated, and absence is unknown, not "not waiting". No new RPC
method or stream opcode.

## Saved session context

`artifacts.searchContextDocuments` and `artifacts.resolveContextDocument` are additive
read-only methods using the desktop's own Slite or OmniOS credentials. Older hosts
refuse the unknown methods; document search shows an update message. Credentials are
never returned to the renderer or moved to a session's execution host.

`promptQueue.enqueueContext` is a separate authenticated-person method carrying the
exact native provider identity or structured session ID. The execution owner captures
the PTY process proof and persists it in a `session-context` entry origin. Delivery
rechecks the provider identity and original process before writing, including after a
restart. Older hosts refuse this method; callers never fall back to plain enqueue.
Older queue readers drop unknown origins, so a downgrade cannot strip the guard and
send those attachments to a replacement session. Recovery uses a stable message ID
to recover the existing receipt after a lost response. Existing enqueue schemas and
stream opcodes are unchanged; direct SSH context remains saved for the next turn.

## Current reply decisions

`nextSteps.list` may add `replyDecisions` for explicit unanswered closing questions
in current owner-confirmed parsed turns, plus the observing process's
`executionRuntimeId`. The existing shared poll reads local decisions and makes one
bounded read per loaded connected paired owner. Older hosts omit the fields and
no question is inferred from ordinary suggestion counts.

Remote projection requires the current pairing revision, runtime identity,
connection generation and exact mirrored workspace, tab, pane and provider source.
New work, a changed source, a disconnected owner or a failed read revokes it.
PTY decisions add `ptyProof`: the owner's current turn key, provider identity and
full reply digest. Local and mirrored clients bind it to unchanged source evidence
captured across the list read; neither compares the owner's completion time to a
renderer clock. The owner's prompt is not equated with a client's preview; client
prompt changes invalidate only the captured local source. Missing proof fails closed.
Local addresses never establish remote authority; SSH relay hooks keep their
existing attention path. No next-step write is forwarded by this reader, and no
request parameter or stream opcode changes.

## Host resource badges

`sessionHost.hostStats` is an additive, read-only session host method negotiated as
`session-control.host-stats.v1` (owner control is its prerequisite, like every session host
capability). Paired runtimes list it in `status.capabilities` and SSH relays in the optional
`pty.getCapabilities.sessionHost` field, both only while their executor advertises owner
control. Params are a strict empty object; the reply is `{ host, observedAt, memory:
{ totalMemory, availableMemory, cpuCoreCount, loadAverage1m }, liveSessions }`, where
`liveSessions` counts the host's registered conversations whose verdict is `live` and is null
when its registry cannot be observed. It is never admitted, journaled or given an origin.
New clients refuse older hosts before sending (`unsupported-capability`), and an older host
called anyway answers `method_not_found`, which becomes the same refusal; either way the
desktop shows a dash for that computer and never estimates. Hosts with remote controls
switched off advertise nothing, so they show a dash too. Old clients never call it. No
stream opcode or existing field changes.

## Sidebar Pause

`sessionOwner.pause` is an additive, authenticated-person-only RPC. Its strict request
pins the execution runtime, owner coordinates, provider identity, PTY and captured
turn (or structured session, turn and runtime fence). The owner disables Keep going
and uses its existing guarded interrupt or structured cancellation. Queued prompts
are retained and reported. Old hosts refuse the unknown method; clients must ask
for an update and never fall back to raw terminal input. Unconfirmed receipts must
not be retried automatically. Existing CLI and session-host caller gates are unchanged.

`agentSession.history` may add `turnState` with the full owner's active turn ID,
lifecycle-known flag and awaiting-start flag. Old clients ignore it. Sidebar Pause
requires this snapshot on structured conversations; a truncated history page is
never substituted for active-turn evidence.

## Host-owned structured session status

`agentSession.subscribeStatus` uses the existing JSON RPC stream and
`agent-session.status-feed.v1` capability. The host projects journals and its live
provider roster independently of renderer transcript readers. Cached summaries
retain history; only the live roster supplies `worktree.ps` execution ownership.
Optional `hostExecutionOwned`, monitoring and failure fields are additive. A lost
stream revokes ownership immediately and fences late frames; it never proves exit.

Some earlier OmniConsole builds advertised v1 without implementing the method.
New clients therefore treat `method_not_found` as an older host and retain the
legacy per-tab transcript reader, without retrying the unsupported stream forever.
A re-paired environment has a separate feed owner. No new binary opcode is added.

Hook `evidenceObservedAt` is optional and independent of the delivery watermark.
Relay replays preserve the observation age while delivery still advances past a
transient clear. Mirrored rows age on the receiving clock and identical evidence
does not renew it. Old hosts fall back to their existing timestamps. The existing
freshness window affects confidence only, never declares completion; a connected
structured execution owner does not time out just because its turn is quiet.

## Local advertising status review

Structured advertising action responses may carry an explicit
`local-human-action.v1` / `local.meta.graph` preview and receipt. This separate
variant is never coerced into signed-backend authority. Existing backend records
and RPC request shapes are unchanged. Old clients hide local recommendations
because their persisted `recommendationOnly` flag remains true; new clients
against old hosts receive the existing recommendation-only refusal and never
fall back to an agent APPLY prompt. The execution host still owns identity,
credentials, exact preview approval, durable reservations and native readback.
No normal-session path or stream opcode changes.

## Routine structured decisions

Hosts advertise `automation.structured-output.v1` before a new client sends
`structuredOutput` on `automation.create` or `automation.update`. The client
refuses an older host explicitly, including when clearing the option, because
older schemas strip unknown fields. Requests that omit the option keep their
existing behavior. An absent saved field means off; an omitted update retains
the setting, while `null` removes it. The setting contains only the provider,
versioned result contract, and an explicit advertising company/account policy
when applicable. Provider credentials remain on the execution host.

## Live chat input

`agentSession.options` may return `supportsLiveInput: true`. New desktop clients
require this before sending into a working structured session or behind a pending
send. Only the Codex adapter advertises support today. Other providers and older
hosts leave the draft editable, disable regular Send with an explanation, and keep
Stop and explicit Next Steps available. Terminal input keeps each CLI's native behavior.
Updated Codex hosts use `turn/steer` with the expected active turn and a durable
client message ID; an unsupported provider method returns a rejected send, never
an automatic retry or a scheduled Next Step. Existing wire methods, receipt
identities and lifecycle statuses are reused; no stream opcode changes.

Live structured model/effort choices come from the owning host's provider snapshot,
independently of discovery for new launches. Both the client and provider validate
setting changes. Terminal launch controls retain their account-discovery constraints.

## OMP prompt redraws

OMP emits OSC 133 command-finished markers when redrawing user messages inside
the live agent. The execution host confirms a shell foreground before retiring
OMP launch authority or publishing command completion, preserving pending
approvals on both byte-scanned and daemon-fact paths. Failed probes retain the
existing state; delayed results cannot retire a replaced controller or process
incarnation. This uses existing status fields and provider calls, with no new
RPC, capability, or stream opcode.

## OMP session exit

Hosts may advertise `ompSessionExit: 1` in `sessionChain.outcomeCapabilities`.
New clients require it before calling `terminal.endOmpSession`, retaining the
pairing revision, runtime ID, exact pane, PTY and native provider session. The
owning host also verifies the process incarnation and OMP foreground identity
before delivering its native Ctrl+D exit command. Direct SSH/WSL relays refuse;
older hosts keep their existing Terminal exit controls, without a local fallback.
The receipt says only `requested`: disconnects and write acknowledgements never
establish process exit. A repeated request for the same incarnation reuses the
first delivery result. No existing method or stream opcode changes.

Clients translate mirrored tab IDs back to the host's pane coordinates before
resolving or ending a session. A missing status-only native ID can use the same
pane's retained Chat identity; a conflicting live ID always wins. The retained
identity only selects the request: the host still verifies the native session,
PTY, process incarnation and foreground before writing. No new capability or
wire field is required.

## Paired Up next ownership

`sessionChain.outcomeCapabilities` may advertise `upNextRemoteOwnership: 1`.
New paired clients require it before calling `upNext.*` and send the negotiated
`expectedExecutionRuntimeId`. All Up next methods reject an absent or mismatched
runtime ID on a paired request before reading or changing state. The host also
refuses conversations it only relays to SSH or WSL. Local callers may omit the
new field and keep the existing wire shape; older clients have no paired Up next
path. New clients refuse older hosts explicitly without calling Up next locally.

The client retains the peer and pairing revision separately from the returned
conversation address. That address belongs to the execution host, even though its
row key says `local`. A re-pair or changed runtime invalidates the composer; reopen
it to inspect the owning host before continuing. No new stream opcode is added.

A Person block may carry an optional `receive.dueAt` (ISO with offset, whole seconds) on
`upNext.append`/`upNext.update`, and views return it. Older clients ignore it in a view. An
older host's strict draft schema refuses a write that sets it, so the composer shows that
refusal rather than dropping the due silently; writes without it are unchanged. No capability
or stream opcode is added.

Typed `/next` and `/queue` commands in Chat and Terminal use the same connection.
They resolve the pane's conversation and execution owner together at submission;
missing or ambiguous pane ownership refuses the command before an RPC is sent.

## OMP tool approvals

The managed OMP status extension renews an unanswered approval every ten seconds
from its owning native process. Each renewal uses the existing hook event and
re-reads the receiver endpoint, allowing recovery after an app restart without
replaying a command or trusting a persisted prompt as live. Renewal requires the
same tool call and persisted native session and stops on resolution, execution
end, a new agent turn, session replacement, extension reload or shutdown. Older
extensions retain their event-only behavior; no new wire field or capability is
required, and the receiver's status freshness checks remain in force.

The existing `interactivePrompt` string can contain an optional
`{ ompApproval: { tool, toolCallId, summary } }` envelope. It is deliberately
distinct from Claude's `{ approval }`: an older client ignores it instead of
sending Claude's numeric approval key to OMP's selector. A newer client connected
to an older host keeps the existing Terminal approval path when this envelope is
absent. Controls require an exact tool-call identity and an untruncated command
summary; the sender rechecks the live prompt, pane, host and provider session
before every verified control write. This envelope adds no stream opcode or RPC method.

A pending OMP interactive prompt survives a same-owner terminal `working` repaint.
The host keeps the existing blocked status and exact approval envelope until a
lifecycle event resolves it, the owner changes, or terminal completion is observed.
Paired snapshots apply the same precedence over retained terminal status. This
preserves existing field meanings and is readable by older clients; it adds no
capability, field, or stream opcode.

Direct SSH hosts may advertise `acceptedInputVersion: 1` in the existing
`pty.getCapabilities` result. Only then may the client call `pty.writeAccepted`
with the retained PTY ID and incarnation. The relay replies after accepting input
for that exact live incarnation. Older clients ignore the capability; newer
clients keep an unconfirmed result against older hosts and do not substitute or
replay a `pty.data` notification. Ordinary Terminal notifications keep their
existing behavior. A disconnected client or replaced incarnation cannot acquire
authority from a delayed capability response or input-size check.

OMP also publishes turn boundaries through the existing optional `lifecycle`
metadata. An aborted partial answer keeps its content and reports interruption
separately. Older clients ignore that metadata. New clients confirm Stop only
after fresh provider interruption evidence; missing evidence or host acceptance
leaves Stop unconfirmed and offers the existing Terminal control path. No new
stream opcode is introduced.

## Native chat session model identity

Transcript reads and snapshot/replacement/append frames may carry an optional
`model` with the exact `provider/model` identifier. Pi-family hosts recover it from
model-change or assistant records on the owning host. Older peers ignore the
field; newer clients leave it unknown when an older host omits it. Display labels
do not establish provider identity. Historical pagination must not rewind this
live metadata, and replacing or rebinding a transcript clears its prior report.

## Native chat Next-step discovery (retired)

Native chat no longer frames or annotates a typed request: it is sent unmodified and
next steps are set through the UI. Builds before 2026-09-21 wrapped a request in a
length-framed envelope starting with the `omni-outcome-source-v1` marker; current
readers still decode that legacy envelope from persisted transcripts so the typed
words display and attest correctly. Nothing new writes it. No RPC field or stream
opcode was involved either way.

## Keep going ad pauses

`nextSteps.adPauses` sets one conversation's ad-pause choice (`allowed`, `ask-first`, or `null`
to follow the global `nextStepSuggestions.adPauses`). The desktop calls only its own local
runtime; an older one answers `method_not_found`, which the Keep going header shows as an error
rather than dropping the choice. Keep going states may carry optional `adPauses` and
`lastAdPause`, and a new stop reason `needs-you-ad-pause`: older readers strip the fields and read
the reason as a generic stop. An absent choice means allowed. No stream opcode changes.

## Session written files

`artifacts.sessionWrittenFiles` keeps its first published contract: no params, and
the latest-writing session per pane as `{ paneKey, sessionId, paths }`. Per-session
reads use `artifacts.sessionWrittenFilesV2` with `{ provider, sessionId }`, which
returns paths. A new client that gets `method_not_found` falls back to the old list
and keeps only records whose `sessionId` equals the session it asked for; a record
without one never matches. A host older than both methods yields an empty list. The
host's index file moved to version 2 and keeps version-1 records, which serve reads
by session id until a hook naming that session's provider moves them onto it.

OMP's managed extension marks `agent_end` with `background_tasks_unknown: true` when
its job snapshot cannot be read. It is an optional hook field: listeners that predate
it report such a turn as done, as before. No RPC or stream opcode changes.

Orca's remote-server feature pairs a desktop client to a remote Orca runtime, and
users update the two independently. **Mixed versions are the normal state**, not an
edge case. This page is the contract for changing anything a paired client and host
exchange: the runtime RPC envelope, the terminal binary stream, and the content
either side publishes over them.

`src/shared/protocol-version.ts` says when to bump `RUNTIME_PROTOCOL_VERSION`. This
page covers the changes that do _not_ bump it and are therefore easy to get wrong.

## Rule 1 — a new optional JSON field on an existing frame is safe

Every JSON payload is parsed with a decoder that ignores unknown keys (zod `.strip()`
on RPC params, `JSON.parse` on stream frames). An older peer that has never heard of
the field simply does not read it.

Safe:

```ts
// host adds a field; older clients ignore it
encodeTerminalStreamJson({ kind, cols, rows, hiddenOutputReason })
```

**The field is safe only for as long as every reader treats it as optional.** The
moment a newer client _requires_ it, that client is broken against every host that
predates the field — which is the same defect as removing a field, just discovered
later. If new behavior depends on the field being present, that is Rule 2: negotiate
it, or make the reader fall back.

## Rule 2 — a new stream opcode is NOT safe; negotiate it

`decodeTerminalStreamFrame` returns `null` for an opcode it does not know, and
`runtime-rpc.ts` drops that frame without an error:

```ts
const frame = decodeTerminalStreamFrame(bytes)
if (!frame) {
  return // silently dropped — the sender never learns
}
```

So a new opcode sent to an older peer does not fail loudly. It vanishes, and the
feature behind it appears to hang. Input sent under a new opcode is swallowed.

A new opcode must be announced in the subscribe handshake and sent only after the
peer confirms it. The existing pattern is `SetOutputPaused` (opcode 16):

- the client advertises support in the `Subscribe` frame's `capabilities`;
- the host echoes `capabilities: { outputPause: 1 }` on the `subscribed` event;
- the client sends opcode 16 only after that echo (`stream.supportsOutputPause`);
- the host only acts on opcode 16 when it negotiated it (`stream.supportsOutputPause`).

Reuse an existing opcode with a new optional payload field (Rule 1) whenever that
expresses the change; reach for a new opcode only when framing genuinely differs.

Opcode numbers are permanent. See the `Ack = 13` and `ClaimViewport = 14` comments
in `src/shared/terminal-stream-protocol.ts` for why a shipped number cannot be
reused even if the feature behind it is removed.

## Rule 3 — changing what the host publishes breaks old clients with no wire change

The frame shape can be untouched and the skew still real, because clients react to
frame _content_. PR #12641 is the worked example: the host stopped synthesizing a
finished agent status, and clients running older code saw different content in an
identical frame.

Treat these as wire changes even though nothing in the codec moves:

- a field the host stops populating (an old client reading it now sees `undefined`);
- a value whose meaning, units, or nullability changes;
- content the host stops synthesizing, trims, or starts deriving from a new source;
- a frame the host stops sending, or starts sending, on an existing path.

If old clients cannot interpret the new projection correctly, gate it behind a
runtime capability the same way Rule 2 gates an opcode.

## Enforcement

`tests/e2e/cross-version-wire/cross-version-terminal-wire.unit.test.ts` runs the real
host RPC methods and the real renderer multiplexer from two builds against each
other — current working tree against the newest release tag, in both skew
directions — over one scripted terminal journey (subscribe, input, hide/reveal
snapshot, drop, reconnect).

Run it with:

```bash
pnpm exec vitest run --config config/vitest.config.ts tests/e2e/cross-version-wire/cross-version-terminal-wire.unit.test.ts
```

It fails when a frame is refused by the receiving build's decoder (Rule 2), when the
observed frame sequence changes (Rule 3), or when published snapshot content or
negotiated capabilities differ from the contract. Repeated frame shapes are compared
by corresponding journey occurrence (initial, reveal, reconnect), so a field removed
from one occurrence cannot hide behind a sibling that still publishes it. Adding an
optional field keeps the suite green (Rule 1); making a client depend on that field
turns the new-client/old-host pairing red.

### Never write down what the old side has

The baseline is whichever release tag is newest, so it moves on every cut. An
expectation of the form "the old side does not have X" — a `not.toHaveProperty`, a
`not.toContain`, a hard-coded field list — stops being true the first time a release
ships X. The suite then reddens on whatever pull request is in flight, with no code
change anywhere, and the job trains people to ignore it. That is worse than no test,
because a rolling baseline eventually contains every additive field the wire has, and
adding one is the sanctioned way to evolve it.

Derive the expectation from the baseline that was actually checked out:

- for a published frame, pair each build against a client of its own version and
  compare the skewed pairing against that same-version reference, so the expectation
  is whatever that build publishes today. Compare repeated frames by corresponding
  occurrence with `comparePublishedFieldOccurrences` in
  `tests/e2e/cross-version-wire/published-field-shape.ts`; never union keys across
  initial, reveal, and reconnect frames, because a sibling can mask one occurrence's
  removed field;
- for a negotiated surface, read the old build's advertised capabilities and
  registered method names from its checkout, and assert they agree with each other
  rather than asserting the old build lacks them;
- for a "client too old to know X", derive that client's advertised list by removing
  X from the baseline's own list, so the gate stays exercised after X ships.

Name the direction in the assertion. `new client against old server` and `old client
against new server` fail for different reasons, and the host is the only side that
authors a published frame — the terminal `terminalOwner` false positive on 2026-08-29
was misread as a new client sending an unknown field when the old server was
publishing it. Two things are still safe to state literally: the current build's own
contract, and an invariant that holds for every version.

Pinning a legacy ref is the fallback when a contract genuinely needs a release from
before a feature shipped, as `cross-version-browser-placement.unit.test.ts` does with
`LEGACY_BROWSER_PLACEMENT_RELEASE_REF`. It does not rot on a cut, but it is
hand-maintained, so prefer deriving.

`tests/e2e/cross-version-wire/cross-version-agent-session-wire.unit.test.ts` pairs the
same two builds over the structured `agentSession.*` surface. Because a released build
cannot name a capability string its own source never contains, the old side's advertised
list and registered method names are read from the extracted checkout rather than
hand-written. It covers the three skews that surface can fail on:

- an old client — advertising the baseline's list minus this capability — is told the
  whole surface does not exist and reaches no host method;
- a new client against the old dispatcher always gets an answer rather than silence,
  and `method_not_found` for every method that release does not register, so the
  absence is visible during negotiation instead of by calling;
- a cursor survives a host restart: the client's fence is refused as stale with the live
  one attached, and resuming from the held cursor replays only what it missed.

Run it with:

```bash
pnpm exec vitest run --config config/vitest.config.ts tests/e2e/cross-version-wire/cross-version-agent-session-wire.unit.test.ts
```

The harness covers the terminal stream and the structured agent-session surface. It does
**not** cover the session-tab sync channel, legacy agent-session publications, file or Git
RPCs, mobile/E2EE framing, or the relay transport. A change on those paths still needs its
own reasoning against the three rules above.

## Worked example: `agentWait` on terminal and worker reads

`terminal.show`, `orchestration.workerShow` and `orchestration.federationShow` carry an
optional `agentWait` naming a pane parked on a prompt only a human can answer. It is Rule 1 —
a new optional field — but it has a second state that Rule 1 alone does not describe, and
getting that wrong turns a skew into a false "nothing is blocked".

- **present object** — this pane is waiting, with the evidence that proved it.
- **present `null`** — the host evaluated this pane and nothing proves a wait.
- **absent** — the host never evaluated it: it predates the field, the worker identity was
  unverifiable, the pane was unreadable, or the agent probe did not answer in time.

A new client against an old host sees the field absent, which is why absence must read as
_unknown_ and never as _not waiting_. Collapsing absent into `null` at any hop — including a
convenience `?? null` in an RPC handler — makes an old or unreachable peer indistinguishable
from a healthy idle worker, which is the exact failure the field exists to remove.

An old client against a new host ignores the key, as Rule 1 allows. New members added to
`RuntimeTerminalWaitBlockedReason` are also Rule 1: no consumer switches exhaustively on it,
and both the CLI and worker-start interpolate it as an opaque string.

## Known debt: JSON-RPC errors drop Node's string code

An error raised on an SSH host crosses the relay as JSON-RPC, and
`ssh-channel-multiplexer` rebuilds it with the TRANSPORT's numeric `code`. Node's
string code — `'ENOENT'`, `'EACCES'` — does not survive, so a caller on this side
cannot ask what kind of failure it was.

`isENOENT` in `src/main/ipc/filesystem-path-containment.ts` pays for that by also
matching Node's canonical message text, which is what makes remote worktree creation
work. The cost is that a host can make an unrelated failure read as "absent" by
putting that sentence in a message.

The exit is Rule 1: carry the original string code in a new optional field on the
error payload and read that instead. An old host omits it and the message match still
covers them; once hosts that send it are the floor, the message match can be deleted
rather than lived with at its ~10 call sites. Narrowing `isENOENT` back to `.code`
without doing this reinstates the bug — the transport has already overwritten it.

## Known hazard: clients ignore host-published failure fields on client-placed pages

`RuntimeMobileSessionBrowserTab` — the browser tab a host publishes on the session-tab sync
channel — permits `placement`, `loadError` and `certificateFailure` together. But for a tab
whose `placement.kind` is `'client'` the engine runs in the client's own app: the failure is
raised by the local guest webview, and the host has no view of it (`RuntimeBrowserClientPage`,
what the registry actually publishes from, carries neither field). Clients from
this version on therefore refuse host ownership of both records for client-placed pages
(`web-session-tabs-sync.ts`, the `placement?.kind !== 'client'` carve-outs) — without that,
each metadata snapshot deletes the locally recorded failure and the page's failure overlay
disappears mid-navigation.

The hazard is forward-facing and Rule 3 shaped. A host that later starts publishing
`loadError` or `certificateFailure` for a client-placed page reaches these clients as content
they silently drop, so the host would see no error and no effect. Publishing it has to be
capability-gated, with the carve-out narrowed to clients that did not negotiate the
capability. Note the cross-version harness does not exercise the session-tab sync channel, so
nothing fails if this is forgotten — this note is the only record.

A related carve-out covers `title`, `url`, `loading`, `canGoBack` and `canGoForward`
(`resolveMirroredBrowserPageContent`), and for those the hazard is already live rather than
forward-facing: the host does publish them, from a `RuntimeBrowserClientPage` it can only learn
about second-hand through the client's own `browser.clientHost.pageMetadata` calls. Its copy
therefore starts at the registry defaults (`'Browser'`, the create-time url), and while those
publishes are failing it never leaves them.

That copy is not simply behind, though, and a client must not treat it as such. When a lease
reattaches, the host refreshes the page from the client host's own inventory
(`runtime-browser-client-page-recovery.ts`), which reads the live guest — so it can be strictly
fresher than a local row whose pane is unmounted and whose metadata publisher was disposed with
it. A client that ignores the host url is relying on its own guest to re-answer on remount,
which `ClientHostedBrowserPagePane`'s mount-time `syncNavigation` is what makes true.

These five are therefore refused only by the client whose guest actually runs the page:
`placement.browserHostClientId` is compared against this client's own host id
(`readBrowserClientHostId`). Main stamps that id into the guest-hosting window's
`additionalArguments` at creation, and the preload reads it back out of its own argv — the answer
has to be there before the first snapshot is interpreted, which is earlier than any IPC handler a
renderer could wait on. Every other viewer — a second desktop, the web client, which installs no
page renderer at all, the dashboard pop-out, which is deliberately left unstamped — keeps tracking
the host, which is the only reason a mirrored viewer shows anything but its first snapshot
forever. Improving what a _second_ client sees still means fixing the publish, not the carve-out;
the carve-out no longer stands in the way of it.

The two failure fields above are deliberately left on the looser `placement?.kind !== 'client'`
predicate. It is unobservable today — the host publishes neither field for a client-placed page at
all, so a mirror has nothing to take either way. If the capability-gated publish this section
anticipates ever lands, narrow them the same way rather than by placement kind: a mirror should
take a failure it cannot otherwise see, and only the hosting client should refuse it.

## Agent hook HTTP headers

Hook scripts can outlive a desktop or relay upgrade. Their authentication and
metadata header names are wire contracts, even when the product name changes.
New writers send the established `X-Orca-Agent-Hook-Token` and the previously
accepted `X-Omni-Agent-Hook-Token` with the same token. Raw JSON writers also send
both spellings of `Agent-Hook-Meta` and `Agent-Hook-Meta-Encoding`. This lets a
writer reach a listener that recognizes either older spelling.

Desktop and relay listeners accept those names and the already-generated
`X-OmniConsole-*` spelling. Every present authentication alias must equal the
current listener token. Conflicting aliases, duplicate token fields, missing
tokens and incorrect tokens fail authentication; aliases have no precedence.
Conflicting metadata aliases are dropped before ingestion. Body errors retain
the existing fail-open HTTP 204 response, so a 204 alone does not prove delivery.
The `ORCA_*` endpoint variables, body format, pane and launch authority, and
protocol version remain unchanged.

`src/main/agent-hooks/hook-wire-compatibility.test.ts` exercises actual desktop
and relay HTTP delivery and rejection. `hook-post-command-delivery.test.ts`
executes generated Bash/curl hooks against listeners that recognize only one
older spelling, preserving raw/form payloads and Unicode metadata.
`windows-hook-payload-delivery.test.ts` verifies both token headers through the
installed cmd.exe and Git Bash launcher on Windows. These tests use synthetic
events and owned loopback listeners; no provider execution is required.

## Mobile E2EE v2 identifiers and code-less reconnect errors

The `orca-mobile-e2ee` protocol name, transcript domain and HKDF salt/info labels
are permanent v2 wire bytes. Product branding must not rename them: existing
mobile clients validate the transcript and derive their traffic keys independently.
The original normative vectors stay unchanged. The desktop/mobile interop test
bundles both actual implementations and exchanges text/binary frames with replay,
peer-key and context rejection; only Expo RNG is substituted, and deterministic
injected nonces make any call to that substitute fail the test.

Code-less transport errors from Orca, Omni and OmniConsole versions are normalized
only for their known product-name spelling before matching transient connection
messages. A present error code remains authoritative, including authentication,
protocol and unknown codes. The actual web waiter/request-registry tests cover
transient failures and authentication rejection without opening a connection.

## Dispatch status prompt prefixes

The normalized dispatch prompt retains the established `You are working inside
Orca, a multi-agent IDE.` prefix because older peers use it to recognize task
status. Readers accept both Orca and OmniConsole preambles; raw prompts may use
the current product name. Normalization emits the established prefix, task ID
and bounded task preview so mixed-version clients can still label the task.
`agent-status-types.test.ts` covers both incoming spellings; renderer task-label
tests cover recognition and stale orchestration-label rejection.

## SSH hook source submissions

`agent.hook` may include optional `submittedPrompt`, the bounded full text from a
live root user submission. It stays separate from normalized status previews and
is never included in relay cache/spool replay. Main revalidates its new-turn
provenance, then stores it with the existing launch/workspace/connection authority.
An old client ignores the field. An old relay omits it; the new client invalidates
the prior source when the new turn arrives and cannot file from a truncated preview.
If the complete envelope exceeds an attached sink's frame cap, the relay drops
`submittedPrompt` whole before shedding status detail, retaining the new-turn
marker so a missing source cannot leave earlier authorization active.

The relay's authenticated loopback hook endpoint answers every event, including
Claude/Codex/Kimi `UserPromptSubmit` and Gemini `BeforeAgent`, with an empty 204,
like the desktop. It no longer returns Next-step context. Managed scripts that relay
a bounded (1 KB) JSON reply therefore print the neutral `{}`; older scripts that
discard response bodies are unaffected.

## Canonical task-context recovery

The desktop's existing `consoleWorkflows:sessionTaskContext` request accepts an
optional `sourceKey` and either a legacy `ses_` ID or a canonical `als_` ledger ID.
A source-only read resolves the signed person's persisted pane identity in main,
then confirms its exact public server row before and after context compilation.
This neither creates a session nor declares a restored process live. Older main
processes refuse the new request shape; the renderer retains its unavailable
context warning and offers the existing attachment flow. Legacy requests remain
unchanged. Next-step planning accepts a canonical ID only through the same
principal-bound registry and server binding, with the existing execution-host
and process-incarnation checks; it never substitutes a local process for SSH.

## Task links across native conversation resume

The main-process pane journal may retain an optional `resumeIdentity` containing
agent, provider session key/id, workspace and exact SSH connection (null for
local). It is historical binding evidence, never a process-liveness claim. A
fresh, host-acknowledged explicit resume receives its own ledger ID and carries
a person's task only when all of those fields and the account match. Conflicting
source tasks, an explicit destination binding/removal, an unavailable provider
resume, and unknown legacy identity do not infer a link. Original task records
are retained. No remote execution or remote filesystem read falls back to the
client.

The optional desktop `sessionLedger.taskLink` read discovers a saved task even
before the provider's first turn. The renderer verifies the new canonical binding
through the existing principal-bound task-context endpoint before caching it or
injecting context. Old main processes lack the method and keep the existing
attachment flow. This adds no relay RPC or stream opcode.

## Jira session links

The optional desktop consoleWorkflow methods `jiraSessionConfig`, `jiraSessionTasks`,
`jiraSessionTask` and `attachJiraSession` reuse the signed person's canonical console
and existing session ledger. Older main processes lack these methods; the new picker
shows an update message and never falls back to a Hub write. No relay RPC or opcode is
added. The principal-bound ledger registry resolves local and remote source keys;
missing ownership refuses rather than substituting another host or conversation.
The existing context refresh accepts a provider-qualified Jira ID, with optional
`workRef`, `title` and `context.work_ref` on its result. Those references are context,
never process authority or permission to create/complete a Jira task. Old clients
cannot write these links through legacy card fields.

## Session When finished preference

`upNext.list` adds optional `finishReady`: the execution host confirms a successful
source turn, no pending prompt/draft, and completion of any bound outcome. Older
clients ignore it. New clients require the field before saving a When finished
choice and never execute one unless it is explicitly true. Missing or unreachable
hosts cannot be treated as finished. The close/save preference and folder remain
per-device presentation metadata, using the existing authenticated profile scope.
No new RPC or stream opcode is added.

## Session execution and passive monitors

Claude hook envelopes may include optional `claudeNonAgentTaskExecuting`. It refines
the existing pending-background-work flag using typed running command/workflow
inventory. Older receivers ignore it; newer receivers treat absence as monitoring,
without assuming the work finished. It is transient host evidence, excluded from
persisted status replays. No RPC or stream opcode changes.

Since 2026-09-24 a newer host publishes a finished turn with live background work
(Claude shells/workflows/monitors/crons/background children, Codex children that
outlive the lead, OMP async jobs from its session job snapshot, structured-session
background tasks) as `working` +
`workingMode: 'monitoring'`, never plain `working`. The envelope booleans keep
their meaning. Old clients already render that pair as Waiting, so this changes
published content only. Status payloads and structured summaries may add optional
`backgroundTaskCount` (positive integer, clamped to 999, only with working +
monitoring); older receivers drop it and show the phrase without a number.

## Managed hook process ownership

Hook protocol v2 appends optional `agentPid` and `agentPidHost` metadata. POSIX
scripts resolve the nearest non-shell ancestor on each invocation; embedded
plugins report their own process ID. PID-less scripts (including native Windows
batch hooks) retain legacy behavior. A v1 raw-JSON receiver requires exactly six
packed fields, so new scripts keep that layout when its endpoint advertises v1;
form receivers ignore the additional fields. New receivers accept both layouts.

Main fences local events before normalization: another PID cannot change identity,
status, prompt caches or background-work evidence while the bound PID lives.
Only ESRCH permits rebinding; SSH/WSL PIDs are never probed on the client. Bindings
are transient and move with pane aliases. Legacy events do not release a binding.

Provider-session metadata may retain a `verifiedFallback` transcript identity.
Claude restore rechecks files on the execution host, allows a short creation
grace, chooses the verified fallback if necessary, and derives the original
config directory from the selected transcript. Local checks never substitute
for SSH/WSL filesystem authority. Older clients ignore the optional fallback;
there is no new stream opcode.

## Prompts another session queued

`sessionManage.ask` accepts optional `expectedRef` and `requireKeepGoingOff`.
The CLI preserves `--ref` through the request so a pane reassigned after lookup
refuses before queueing. Known terminal provider identities are pinned through
the existing prompt binding until delivery. `requireKeepGoingOff` only refuses;
it never changes that setting. Older strict schemas reject these fields, and
callers must not retry without them. The Keep going precondition currently
refuses remote targets; an SSH peer adapter invokes the recipient's local CLI.
No new transport or stream opcode is added.

Handoff/consolidation's `archiveSessions` window relay is local-only. Its request
carries complete source identities and an expiry, and its receipt returns those
identities. Incomplete or expired requests refuse before a store mutation. A lost
receipt is reconciled from current sidebar state after the expiry, never by replaying
the archive. Unavailable or replaced rows leave the outcome unknown. No paired-host
RPC, capability or stream opcode is introduced.

`omni session continue|ask` queue entries carry `requestedBy: {action, actor}`, a new optional
field; `origin` stays Keep going's alone. A client that predates the field keeps the entry, with
its visible "[from …]" marker, instead of rejecting an origin kind it cannot read (which drops
the whole entry). Pre-release builds that wrote `origin.kind: 'session'` are read back as
`requestedBy`. The Keep going stop such an action causes uses the person's existing reasons
(`person-message`, `person-stopped`) with the acting session named in `stopDetail`, so no new
stop-reason value reaches an older client. No RPC, capability or stream opcode changes.

## Native launch sidebar adoption

`terminal.createAgentSession` optionally accepts `revealInSidebar` for a local
controller’s terminal launch. It reuses inactive renderer adoption with
`surfaceOwner: false`, retaining the same spawned PTY without selecting a workspace
or tab. Paired/mobile callers and focused/chat combinations refuse this option
before account selection or spawn. Old strict schemas reject it; clients must not
retry without it after an uncertain launch. When omitted, legacy operation
fingerprints and background-only behavior are unchanged. The option participates
in both request and execution fingerprints. Renderer adoption failure keeps the
live terminal receipt and warning, never a second launch. No relay or stream
opcode changes.

## Session inventory filters

`sessionManage.list` accepts optional `hostId` and `query`. The strict schema
rejects malformed host identities rather than widening the search. Host matching
uses canonical execution identities before process observation, and literal query
terms filter the resulting metadata without changing execution verdicts. The
optional response `scope` identifies controller-sidebar coverage and archive/filter
selection. It makes no claim about unadopted terminals, other controllers or
historical transcript coverage. Old clients ignore scope; old strict controllers
reject new filters, and the CLI never retries without them. No new execution or
remote-caller authority is granted.

## SSH Session prep account selection

`terminal.createAgentSession` optionally accepts `sshAccountSelection` with the
`best-verified` policy, exact expected SSH host ID and expected controller runtime
incarnation ID. A changed controller refuses before selection or spawn because its
in-memory create ledger cannot recover the original operation across restart.
An older runtime's strict
request schema refuses the new field; callers must not retry with an unprepared
legacy launch. The native operation ID includes this policy and destination, and
account preparation happens inside its existing reservation. Credentials are never
request parameters. This path requires terminal presentation; the controller checks
workspace/target identity and the capacity reading's remaining freshness again at
the synchronous pre-spawn boundary. Existing requests without this field retain
their previous operation fingerprints.

`agent.prepareSessionAccount` is an additive relay request for Claude/Codex account
selection on the execution host. Its strict response carries the profile directory,
default-profile pinning decision, verified remaining capacity, reply-time reading age
and relay processing duration. Credentials never cross this method. The controller
bounds reading age plus transport time and requires the expected provider.

Older relay daemons return method-not-found: Session prep refuses with an update
message and never substitutes the controller account or silently uses a remote default.
Reconnect with an updated app/relay to enable it. A malformed reply also refuses.
Prepared launches reuse the existing PTY/`agent.exec` environment field; no stream
opcode changes. Blank auth overrides clear inherited API keys. POSIX prepared launches
also reapply the profile and blank overrides in the CLI command after shell startup;
other shell dialects refuse this prepared-account path. Each SSH text helper
owns a unique execution lane and cancels that lane through existing `agent.cancelExec`
on timeout, so a sibling preparation cannot inherit abandoned queued work.

## Verified account launch on any host

Capability `agent-session.verified-account-launch.v1` (not in `RUNTIME_CAPABILITIES`) is
pushed by `getStatus()` only when the runtime has account capacity services, so orcad never
advertises it. It covers everything below; the contract is `docs/reference/agent-launch.md`.

- **Widened value.** `sshAccountSelection.expectedHostId` also accepts `local`
  (`/^(local|ssh:[^\s]+)$/`): a runtime's own workspaces, which includes a paired runtime
  executing for its controller. The field name is historic. The host picks from its own
  account capacity rows and pins the chosen row. Existing `ssh:` requests and both operation
  fingerprints are byte-identical. An old runtime's strict schema refuses `local` with
  `invalid_argument`; the CLI never sends it without the capability and records that refusal
  as unverifiable, never as a reason to retry differently.
- **Readiness.** `terminal.agentLaunchReadiness {worktree, agent, model?, preview, load?}`
  (strict) is read-only. It returns the executing `runtimeId` and the resolved workspace with its
  `hostId`; with `preview: true` it also returns the account it would pick, or
  `verified: false` with each candidate's state and reason. Registered on every runtime; orcad
  answers `verified: false`. It is not an unattended-caller or mobile method.
- **Placement fields (Rule 1, no new capability).** With `load: true` the result adds optional
  `load` (`{loadPerCore, band, liveSessions, observedAt}` or `null`) and `machineId` (a session
  host id or `null`). Without `load` both keys are absent; old clients ignore them. Absent and
  `null` both read as unknown, never idle. Because the params are strict, a runtime that has the
  capability but predates `load` refuses it with `invalid_argument`; the placement reader then
  asks once more without `load` (readiness is read-only) and treats load as unknown. A new
  optional param on a strict schema needs that retry, or a capability, on the caller side.
- **Result fields.** `createAgentSession` results gain optional `account` (the receipt:
  label, remaining percent, bounding window, reading age, why) and `launch` (effective model,
  effort and their source). Old clients ignore them; replays return the stored values.
- **Coded refusals.** `agent_session_account_unverified`, `agent_session_runtime_changed` and
  `agent_session_host_mismatch` pass through `rpc/errors.ts` with their `data` instead of
  collapsing to `runtime_error`. SSH capacity refusals keep their text and gain the code, so
  old CLIs print the same message.
- **Old hosts refuse by name.** A runtime without the capability gets no `local` request, no
  readiness call and no fallback: the CLI refuses with `incompatible_runtime` naming the
  computer and its version before anything is recorded or sent. The one exception is an
  explicit `--host ssh:<id>`, which sends the pre-existing SSH payload unchanged, because that
  path already verifies capacity on the relay. Never `terminal.create`, never an unprepared
  `createAgentSession`.

No relay request or stream opcode changes.

## Session answer command evidence

Approval journal bodies may carry an optional `command` string from the provider's
executable command, separately from its displayed reason. Existing clients keep
rendering `detail`; no stream opcode or response shape changes. New session-answer
readers refuse `--allow` for Codex approval rows without command evidence, while
`--deny` and the ordinary target-session controls remain available. Commands and
details are bounded with visible truncation markers; truncated evidence cannot
authorize an answer. Claude Bash rows retain their JSON-input decoding path.

## Session-search coverage

The `sessionSearch.query` host rows describe coverage, not process liveness. A
successful RPC with `failed`, `unsupported` or missing host evidence must not become
`searched`. When querying a paired runtime with `includeRemote: false`, use its
`local` coverage row; retain compatibility with a single legacy unqualified row.
Unknown states and invalid replies leave coverage incomplete.

Full-scope searches also list registered SSH targets as outside transcript-search
coverage. No SSH index or connection is started by this reporting. Local-only
queries exclude both paired fan-out and SSH coverage rows. Empty results never
prove there is no matching conversation on an unsupported or unreachable host.

## SSH guarded stop

`pty.readAgentProcessEvidence` may include an optional `interruptToken` in its
foreground proof. It grants one Ctrl+C attempt for that exact owner, incarnation,
process birth and terminal input generation, valid for 15 seconds on the relay's
monotonic clock. `pty.interruptAgent` accepts only that ticket, never arbitrary
input. Every physical relay input invalidates unconsumed tickets. Output does not:
a working agent may keep producing output while its stop is in flight.

The execution owner checks process identity, command recognition, TTY/foreground,
input generation and connection immediately before the synchronous guarded write.
Consumed tickets replay their acknowledgement without a second interrupt. Each
PTY retains at most 32 tickets; expiry/eviction or replacement yields unknown for
missing receipts, never a claim that an earlier interrupt did not happen.

The controller checks its conversation fence before dispatch and aborts an
in-flight request on revocation. This cancellation is best effort across SSH;
lost, cancelled or mismatched replies are unknown and never retried automatically.
This is an owner-guarded stop, not the local daemon's synchronous shared-file
conversation fence. It deliberately grants no prompt, approval-key, restart,
relocation or exact-turn cancellation authority. Paired session controls still
route separately. Older proof readers ignore the optional field; absent tickets
or an old relay's method-not-found response refuse stop with no raw/local fallback.

## SSH agent process observation

`pty.readAgentProcessEvidence` is an additive, read-only relay method. The relay
pins its root process at spawn and samples its own foreground process tree. Its
reply is bound to the requested PTY incarnation; a replaced owner, disconnected
transport, malformed reply or old relay leaves observation `unverifiable`.
Method-not-found is cached only for that provider instance. No stream opcode or
existing request changes. The process fields alone grant no input or signal
authority; only the optional stop ticket above enables Ctrl+C. Guarded SSH prompt
mutations remain unavailable until an execution-host writer can enforce their
conversation guards at delivery.

## Paired controller SSH search coverage

`sessionSearch.query` accepts optional `includeOwnedSsh` and acknowledges it with
`ownedSshCoverage: true`, including when no SSH targets are registered. It reports
that controller's SSH targets without paired fan-out; `includeRemote: false`
alone retains local-only behavior. Old request schemas ignore the new option;
without the acknowledgement, newer clients explicitly mark owned SSH coverage
unknown. An invalid or ambiguous inventory also remains incomplete.

Forwarded SSH coverage carries optional `ownerEnvironmentId` and `coverage` fields
and a label naming the controller. The private SSH target ID is never interpreted
as a target registered on the requesting computer. SSH content hits are not
restamped as paired-local hits. This change reports coverage only: it does not
add SSH transcript indexing, input controls or process-liveness evidence.

## Explicit recipient file delivery

`files.deliver` is a new request with a strict schema. It names the exact source
execution host and recipient runtime incarnation, and either the recipient's
desktop filename or absolute destination path. A mismatched recipient refuses
before source capture. Old runtimes reject the unknown method; clients must not
fall back to a worker-local write. Results carry a verified recipient path, size
and SHA-256. Existing files with different bytes are never overwritten. This adds
no stream opcode, server upload or binary public-link service.

## SSH relay exit evidence

A new relay reports JSON-RPC error code `-32047` with the exact missing PTY ID
only after observing that PTY exit. It retains at most 4096 such observations;
eviction or a relay restart leaves the result unverifiable. A foreign relay
generation, identity mismatch or missing stream checkpoint never authorizes a
replacement session. New clients retain saved bindings when older hosts return
unqualified not-found errors. Old clients retain their existing not-found
behavior for confirmed exits; unknown IDs now receive an unverifiable error.
The existing JSON-RPC error envelope carries the code, with no new method or
stream opcode. Reconnecting to an older retained relay is separate from proving
exit; this contract does not transfer or stop sessions.

### SSH transcript content search

`sessionSearch.query` is an optional SSH relay request (query <= 512 characters, limit <= 100). It runs only in the existing low-priority history child, reusing the desktop transcript parser, redaction, SQLite index and ranking. The child starts its index lazily and keeps a separate persistent index for each owning relay socket, preventing concurrent relays from writing the same index. Its private cache directory lives inside that relay build so the existing liveness-aware version GC removes retired indexes; `passes` and `pendingFiles` keep partial backfill distinct from a searched host. Known Claude/Codex profile roots are discovered on the execution host; credentials and the controller's profile paths are never sent to it. SSH initially provides lexical ranking/extractive summaries; no model downloads or paid summary calls are started.

A missing method or missing node:sqlite stays unsupported. A disconnected/unknown target stays unreachable and is never automatically connected by a search. The controller checks that the relay did not change during the reply and stamps each accepted local-owner hit with that controller's exact SSH target identity. A peer controller's private SSH target IDs must never be interpreted as this controller's targets: nested-owner hits remain excluded until their own open/routing contract exists. Existing paired-runtime search stays intact. Retaining an older relay for live sessions does not grant it this newer capability.

## Provider conversation ownership lock

The Codex ownership banner plus retry control now uses the existing
`codex-interactive-prompt` wait reason. Native guarded prompt delivery refuses
while it is visible, and session management reports `awaiting-user` with the
ownership conflict even when earlier title/screen evidence said idle. A later
ready prompt clears the historical lock. No retry key is sent automatically.
There is no new RPC, enum value or stream opcode; the detailed screen marker is
internal to the controller observation path.

## Session host control (Phase 4 package A)

`sessionHost.*` is served over the existing runtime RPC and relay JSON-RPC; no stream opcode is
added (docs/reference/session-host-control.md). Everything is Rule 1 or negotiated:

- `runtime.status` gains the session host capability names and an optional
  `sessionHost: { hostId, incarnation }` only while an executor can carry them out; the
  incarnation is the runtime's `runtimeId`. Older clients ignore both.
- `pty.getCapabilities` gains an optional `sessionHost` field under the same rule. Until then the
  answer is exactly the pinned `LEGACY_RELAY_PTY_CAPABILITIES`, and the extra field can never
  replace a field released relays send.
- A new client declares its support on the runtime socket (`clientCapabilities`) and, on a relay,
  with the new `sessionHost.declareClient` request once per connection. An older relay answers
  `-32601` and an older runtime `method_not_found`; both become `unsupported-capability`, never a
  local or raw-terminal fallback.
- Refusals are result values, because relay JSON-RPC rebuilds errors with a numeric code.
- An old client never declares, so a new host refuses it control while its organization data
  stays visible; its old `sessionManage.*` paths stay local-only as before.

## Session host owner service on paired runtimes (Phase 4 package B1)

- A paired runtime now advertises `session-control.owner.v1`, `session-organization.host.v1` and
  `session-waits.remote.v1` in `runtime.status`, with `sessionHost: { hostId, incarnation }`, while
  its `sessionHostControl.remoteControls` switch is on (the default). This is the Rule-1 advertisement
  package A defined; older clients ignore it. An SSH relay advertises nothing yet.
- Prompt-queue entries gain two optional fields: `requestedBy.hostOperation`
  (`{ operationId, conversationId }`) on a prompt the session host admitted, and `unsent: true` on a
  failed entry that provably sent nothing. Both are additive. An older reader drops them and keeps
  the entry; `normalizePromptQueueEntry` keeps them only when well formed.
- Operation `result` values (`{ entryId, deliveredAt, door }`, `{ outcome, reply? }`, `{ summary }`,
  `{ revision, organizationRevisions, mode }`, `{ receipt }`) are new content inside the existing
  `unknown` field. A client must read them leniently.

## Session host owner service on SSH relays (Phase 4 package B2)

- A relay now answers `pty.getCapabilities` with the optional `sessionHost` field (package A's shape):
  `session-control.owner.v1` and `session-waits.remote.v1`, plus the relay's `hostId` and incarnation,
  unless `OMNI_SESSION_HOST_DISABLED` is set on the host. A released client ignores the field; a client
  that reads it negotiates before calling `sessionHost.*`.
- No stream opcode or PTY frame changes. The relay writes an admitted prompt to the PTY itself, exactly
  the bytes a Mac's prompt write would send (bracketed paste, then Enter).
- New capability `session-control.delivery.v1` (prerequisite `session-control.owner.v1`) and action
  `deliver` (`{ text, writer }`, strict). A Mac sends it only after negotiating that capability with the
  relay, so an older relay (which would refuse the unknown action) is never asked. Without it, the Mac
  writes to the PTY as before.

## Moving a conversation away from an SSH relay (Phase 4 package B3)

- A relay with package C's relocation handler adds `session-relocation.claude.v1`,
  `session-relocation.codex.v1` and `session-relocation.bundle.v1` to its `sessionHost` field. It
  adds no capability name, method, field or opcode: these, and the bundle calls, are E2's.
- A client negotiates them as it does with a paired runtime. An older relay advertises none of them,
  so the relocation preflight refuses it before the source is touched.
- A relay takes the source steps only. It refuses `relocate.prepare-destination` with a plain
  reason, which a relocation asks before it freezes the source, so an older client that tries to
  move a conversation to a relay changes nothing.

## JEV controls and one-off advice

`jev.status`, `jev.configure` and `jev.request` are additive RPC methods. Controls apply to the selected execution runtime, not the renderer host. Older hosts reject the unknown method; the UI reports unavailable and does not fall back to changing settings or invoking another model. Host/environment kill switches override a request. The new advisory request endpoint never grants action authority or invokes an LLM. It leaves the desktop-only `structuredDecision.jevTrial` caller guard intact. Provider calls already in flight are cancelled when the master switch changes; a late result cannot be returned as a new reading.

## Session agent template

`terminal.create` and `terminal.createAgentSession` take an optional additive `agentTemplateId`
(Rule 1). The host that serves the call resolves it against its own agent templates when the
session starts, after its replay and dedupe checks (a same-operation retry replays even if the
template was since removed), and records `{ id, name, digest }` on the tab it creates (`digest`:
first 12 hex of the sha256 of the template's text). An unknown id on a new launch is
`invalid_argument` before any terminal exists; it never falls back to Default or another
template. `createAgentSession` adds the id to its replay fingerprint only when present, so
existing operation ids replay unchanged.

Old hosts: `createAgentSession`'s strict schema refuses the unknown param, while `terminal.create`
would drop it. The CLI therefore preflights `agentTemplates.list` whenever `--agent-template` is
passed and refuses with `unsupported_runtime_capability` when the host lacks it, and refuses an
unknown id before calling the launch. A remote `omni session launch` refuses the flag, since a
background launch on a paired host creates no tab to record on.

The record is desktop-local. It travels main→renderer inside one host (`ui:createTerminal`,
`terminal:requestTabCreate`) and is persisted with that desktop's workspace session. Direct-SSH
workspace sync strips it in both directions (another desktop would judge it against its own
templates), and the importing desktop keeps its own records by tab id. A paired runtime's mirror
keeps a record the client made on a mirrored tab across snapshots; the host publishes none.
`sessionManage.list` rows gain optional `agentTemplate` (`null` when the launch recorded none;
absent from an older window).

`agentTemplates.list`, `agentTemplates.set` and `agentTemplates.remove` are additive RPC methods
behind `omni agents`. They read and write the serving host's templates through the same settings
write and broadcast the Settings editor uses. An older host rejects the unknown method; the CLI
reports it and changes nothing.

## Browser cleanup

`browser.cleanup` is an additive, strict RPC with preview/apply actions. Old hosts
refuse the method; callers keep the error and never fall back to individual tab
closes. The owning runtime asks its own authoritative desktop window, binds the
preview to that window, and saves a private reopen list before applying. Tokens
expire after two minutes and are consumed once. A renderer viewing another runtime,
a headless host, or a page owned by another browser client refuses cleanup.
The desktop Settings control explicitly targets its own computer; the CLI can
select a paired runtime with `--environment`. There is no new stream opcode.

## Saved terminal reasoning effort

`agent-session.effort-only-launch.v1` advertises that a host accepts Claude/Codex
launch preferences containing effort without a model. The existing JSON shape and
stream opcodes are unchanged. New clients negotiate before sending this selection;
older or unverified hosts report a launch gap and create no session when saved
effort was selected. Hosts need the capability before this selection can launch. Terminal model flags, explicit CLI or
environment selections, custom commands, and provider resumes retain precedence.

Prompted paired terminal launches retain the existing captured client arguments
contract. This capability changes effort delivery; it does not replace captured
terminal model/arguments with the host's saved profile.

## Workflow worker location in the sidebar

`localWorkflow:changed` and its status response add optional `sshHost`, the SSH alias
frozen in a dispatched-seats placement. The sidebar uses an unambiguous saved SSH
identity to filter, count and group the workflow under its worker computer. The
conversation control owner, tab identity and routing stay unchanged. Older owners
omit the field and keep controller grouping; older readers ignore it. A caption alone
never establishes a transport, and no RPC request or stream opcode changes.

### Experimental Need Speed intake and measured launch memory

The `session-prep.routing.v1` capability also guarantees durable request identity acceptance and
the `need-speed` entry point. Need Speed probes that capability before any workspace preparation
or submission; an absent capability displays an update requirement. It uses the existing local
`sessionPrep.request` with an optional top-level
`requestId` and `source.entryPoint: "need-speed"`. Each explicit input row is a separate
request; Reverse Prompting decomposes only that objective. Its planner keeps the existing
Sonnet/low path and direct-item safeguards. Work's existing planner is unchanged. The request
identity and original source, text, project and agent-template choice are persisted before
acceptance. A retry with the same identity and different content is refused; an accepted retry
returns the same batch while that batch remains in the existing bounded store.

Older request schemas reject these new requests instead of silently dropping the retry
identity. The experimental UI uses the current local runtime, including its SSH checkouts;
paired-runtime intake is unavailable. A future remote entry point must negotiate support
before submission. Never retry without the identity after a transport failure.

`terminal.agentLaunchReadiness` results may now include optional `load.freeBytes` and
`load.totalBytes`, from the same fresh HostResourceReader measurement as CPU load. Old readers
ignore these additive result fields; new readers treat absent/invalid values as unknown. No
new request field or resource probe is required. CPU eligibility bands and launch/concurrency
limits retain their existing authority.

## Dispatch router modes

`session-prep.routing.v1` advertises the optional
`session.prep.request.source.routingMode` (`off`, `shadow`, `live`) and additive routing
receipts. A client sending an explicit mode must require this capability: an older
host silently strips unknown source fields and would otherwise run its existing
live behavior. Missing capability means update required, never an implicit mode
fallback. Omitted mode retains existing live routing on both versions. Operator
`OMNI_DISPATCH_ROUTER_MODE=off` takes precedence as a reversible rollback.

The existing classifier is bundled as a portability fallback; the model catalog
belongs to the exact execution host. Advertised model identity and launch choices
do not attest the actual served model. No worker is relaunched after a failed or
uncertain dispatch.

## Structured chat passive viewers (command center Step 3)

`agent-session.structured.viewer-hold.v1` advertises `agentSession.hold`'s optional
`mode: 'viewer'`. The renderer probes a paired host before sending the field;
the bundled local host supports it directly. A viewer restores the readable
journal and retains an existing child without acquiring one. Its response adds
`processState: 'live' | 'exited' | 'unverifiable'`. Read-only journals with live,
conflicted or unreconciled leases report unverifiable rather than exited. Missing
identity and failed requests remain errors, never proof of exit. Explicit Resume
uses the existing resume-capable hold with a temporary holder id, then releases that holder separately.

An older host receives the exact legacy hold parameters and may resume on view.
The pane labels this fallback. A failed capability probe reports unverifiable
execution and does not attempt a legacy hold or change execution hosts.

Status summaries add optional `processState` on the existing status events. Old
readers ignore the field; no stream opcode changes. New readers discard both
live and exited proof on connection loss, retain history, and wait for fresh
host evidence. Journal projection failure also revokes process proof. Passive
viewing and its UI are pane-only, behind `commandCenter`; existing full-page
hold requests and responses remain unchanged.

## Deliverable check records and repair prompts

The turn-end deliverable check (W22-20) runs on the host that classifies the session's turns and
keeps its records there. `deliverables.list` and `deliverables.markFalseAlarm` are additive strict
methods; a client asking an older host gets `method_not_found` and shows no Deliverables block,
with no local fallback (the client's disk never answers for a remote session).

A repair prompt is an ordinary prompt-queue entry with a new optional `automation` field
(`{ kind: 'deliverable-repair', verificationId, attempt }`), never a new `origin` kind: an older
client's field-by-field reader drops the field and keeps the entry with its visible
`[from Deliverable check n/max · dv-…]` marker, where an unknown origin would drop the entry. The
owning host's delivery guard re-reads its own record before the write. No stream opcode or
capability is added.
