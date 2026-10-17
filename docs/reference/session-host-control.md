# Session host control (Phase 4 contracts)

Phase 4 lets the computer that runs a conversation (an SSH relay or a paired runtime) carry out
session controls on it. Other computers ask; the execution host checks policy, reserves the
action, executes it and records the result. Two Macs never both continue the same conversation,
a disconnected host's sessions are left alone, and older clients keep their organization data
but are refused controls they do not understand.

This page is the frozen contract that packages A to E build against. It follows
[ssh-execution-boundary.md](./ssh-execution-boundary.md) and
[remote-wire-compatibility.md](./remote-wire-compatibility.md).

**Status:** contracts, package A's host protocol and admission, package D's headless
organization, package B's owner service on paired runtimes (B1) and SSH relays (B2, and B3's
moves away from a relay), package C's transfers and relocation, and package E's requesting side
(controls, Work and Settings, synced overrides), all below. Every `sessionHost.*` method is
registered on the paired runtime and the SSH relay, but a host advertises a capability only while
an installed executor can carry it out. A paired runtime advertises owner control, organization,
waits and (with C) transfers and relocation; an SSH relay advertises owner control, waits,
delivery and (with B3) relocation as a source only. A host must not advertise a capability until
its methods are implemented. Some earlier builds advertised
`agent-session.status-feed.v1` before its method existed, and clients had to work around that for
good.

## Where the contract lives

| File (`src/shared/`)             | Contents                                                                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `session-host-identity.ts`       | Conversation, host, incarnation, operation and epoch identities; revisions; reservations; grants; relinquishments; `sessionHostDigest` |
| `session-host-capabilities.ts`   | Capability names, prerequisites, advertisement readers for runtime status, relay and client                                            |
| `session-host-negotiation.ts`    | `negotiateSessionHostCapabilities`, `requireSessionHostCapability`/`Method`/`Action`                                                   |
| `session-host-protocol.ts`       | RPC method names, method→capability map, actions and their specs, request, operation, observation and result types                     |
| `session-host-authority.ts`      | Origin evidence, host-derived authority, the `[from …]` title and marker                                                               |
| `session-host-payload-schema.ts` | Per-action payload schemas, relocation manifest and its digest, grant schema                                                           |
| `session-host-schema.ts`         | Strict host-side request and params schemas, `parseSessionHostRequest`                                                                 |
| `session-host-reply-schema.ts`   | Lenient client-side reply readers, `readSessionHostReply`                                                                              |
| `session-host-admission.ts`      | `sessionHostRequestFingerprint`, `decideSessionHostAdmission` (the reference admission rules)                                          |
| `session-host-refusal.ts`        | Refusal codes, retry rules, method-missing mapping                                                                                     |
| `session-host-verdict.ts`        | The verdict vocabulary and `sessionHostVerdictOf`                                                                                      |
| `session-host-sync-doc.ts`       | The `t` account-sync document kind                                                                                                     |
| `session-host-*-fixtures.ts`     | Mixed-version fixtures (wire, requests, sync documents)                                                                                |

## Capabilities

Each capability is negotiated separately before its fields are sent. If a capability is absent,
the answer is an explicit `unsupported-capability` refusal. The client never runs the action
locally and never falls back to raw terminal input.

| Capability                                  | Enables                                                                                       | Requires                           |
| ------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------- |
| `session-control.owner.v1`                  | `observe`, `execute`, `operation`, `reserve`, `release`; continue, ask, answer, stop, restart | —                                  |
| `session-organization.host.v1`              | Headless organization commits (rename, archive, unarchive, organize, undo), `tidy`, `history` | owner                              |
| `session-transfer.remote-source.v1`         | `transfer.prepare-source`, `transfer.settle-source`                                           | owner                              |
| `session-relocation.claude.v1`, `.codex.v1` | `relocate.*` for that provider's native format only                                           | owner                              |
| `session-relocation.bundle.v1`              | `relocationBundleRead`, `relocationBundleWrite` (moving a relocation's files)                 | owner, and a provider's relocation |
| `session-waits.remote.v1`                   | `wait.register`, `wait.cancel`, `waitStatus`                                                  | owner                              |
| `session-control.delivery.v1`               | `deliver`: a Mac's own writers, admitted by the host that runs the conversation (B2)          | owner                              |
| `session-control.host-stats.v1`             | `hostStats`: the host's own memory, cores, 1-minute load and live session count (read-only)   | owner                              |

- **Paired runtime:** the names go in `runtime.status` `capabilities`, plus an optional
  `sessionHost: { hostId, incarnation }` field whose incarnation is the process's `runtimeId`.
  If the names are advertised without that identity, the advertisement is treated as malformed.
- **SSH relay:** an optional `sessionHost: { capabilities, hostId, incarnation }` field on
  `pty.getCapabilities`, following `ssh-agent-session-capabilities.ts`. Relays released before
  Phase 4 omit it, and `LEGACY_RELAY_PTY_CAPABILITIES` pins that answer.
- **Clients** declare support with `remoteRuntimeClientCapabilities(SESSION_HOST_CLIENT_CAPABILITIES)`
  on the authenticated connection. A client that declares nothing is refused control. On SSH, the
  way the declaration is carried belongs to package A.
- **Re-probe** after a reconnect or a host incarnation change. When the binding changed,
  `requireSessionHostCapability(…, current)` returns `renegotiate`.
- If a peer speaks only a newer family version (`session-control.owner.v2`), it is reported in
  `unknownPeerCapabilities`, and the refusal names that version.
- In-process callers never pass through this gate. They use the host's owner service directly
  with `SessionHostAuthority` `local` or `steward`.

## Methods

The same names are served over runtime RPC and relay JSON-RPC. No stream opcode is added.
Refusals travel as result values (`{ status: 'refused', refusal }`), never as RPC errors,
because relay JSON-RPC rebuilds errors with a numeric code. An older host answers a missing
method with `method_not_found` or `-32601`. The client maps that to
`sessionHostMissingMethodRefusal`.

| Method                              | Params                                                                 | Result                                                               |
| ----------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `sessionHost.observe`               | `{ conversationIds?, includeArchived? }`                               | `{ host, observedAt, complete, sessions: SessionHostObservation[] }` |
| `sessionHost.execute`               | `SessionHostRequest`                                                   | `{ status: 'ok', operation }` or a gate refusal                      |
| `sessionHost.reserve`               | `SessionHostRequest` (action = the step it reserves for)               | an `admitted` operation holding the turn                             |
| `sessionHost.release`               | `{ operationId, conversationId, reservation, origin }`                 | the release operation                                                |
| `sessionHost.operation`             | `{ operationId, conversationId }`                                      | `found: true` + record, or `found: false` + host                     |
| `sessionHost.tidy`                  | `{ operationId, apply?, include?, origin }`                            | rows; each applied archive is its own operation                      |
| `sessionHost.history`               | `{ conversationId, limit? }`                                           | `OrganizationHistory`                                                |
| `sessionHost.waitStatus`            | `{ registration, dependency }`                                         | `SessionHostWaitReceipt`                                             |
| `sessionHost.relocationBundleRead`  | `{ relocation, conversationId, provider, path, offset, length }`       | `{ path, offset, size, base64 }`                                     |
| `sessionHost.relocationBundleWrite` | `{ relocation, conversationId, provider, path, offset, size, base64 }` | `{ path, received, accepted }`                                       |
| `sessionHost.hostStats`             | `{}`                                                                   | `{ host, observedAt, memory, liveSessions }`                         |

`observe` covers only this host's registry. A conversation missing from it is not evidence that
the conversation stopped. `found: false` from a reachable host is positive evidence: its journal
never admitted that id. `entry` is a presentation projection keyed to the host's own panes, and
`ref` is what the requesting Mac shows. Showing a session never starts or resumes it.

## The request

```ts
{ operationId, conversationId, expectedOwnerEpoch, expectedTurnRevision,
  expectedOrganizationRevision?, reservation?, origin, action, payload }
```

- `operationId` is `<13-digit ms>-<32 hex>`, minted with `conversationDeliveryOperationId`.
  `conversationId` is `conv_<32 hex>`, an opaque id minted by the host. It is independent of
  paths, Mac aliases and credentials. `expectedOwnerEpoch` starts at 1 and only a consumed
  relocation grant advances it. `expectedTurnRevision` and `expectedOrganizationRevision` are
  opaque, host-minted and echoed from `observe`. `expectedTurnRevision` is null only when
  observe read no turn.
- `origin` is built only by the origin computer's main process: a person's UI surface, a pane's
  launch evidence, or the plain CLI, with any unattended context. It cannot express `steward`.
  A missing origin is refused. `origin.request` is audited, and a request string is never
  approval.
- Schemas are strict. Any unknown key at any level is refused, so a payload cannot carry
  `actor`, `executor` or `authority`. `via` is a bounded string so that a newer surface name
  never breaks an older host.

| Action                                                              | Capability            | Fence                          | Unattended |
| ------------------------------------------------------------------- | --------------------- | ------------------------------ | ---------- |
| `continue`, `ask`, `answer`, `restart`                              | owner                 | turn                           | policy     |
| `stop`                                                              | owner                 | owner epoch only               | policy     |
| `rename`, `unarchive`, `organize`, `undo`                           | organization          | organization revision          | policy     |
| `archive`                                                           | organization          | turn and organization revision | policy     |
| `transfer.prepare-source`, `transfer.settle-source`                 | transfer              | turn                           | refused    |
| `relocate.freeze-source`, `relocate.export`, `relocate.relinquish`  | relocation (provider) | turn                           | refused    |
| `relocate.prepare-destination`, `relocate.stage`, `relocate.resume` | relocation (provider) | destination                    | refused    |
| `wait.register`, `wait.cancel`                                      | waits                 | owner epoch only               | policy     |
| `deliver`                                                           | delivery              | turn                           | policy     |

In this table, "policy" means package B's unattended policy decides. The origin host and the
execution host both enforce it, and the stricter one wins. "Refused" is a floor that no policy
can relax. An unattended steward may propose a relocation or transfer but never perform one.

## Authority and markers

The host builds `SessionHostAuthority` from the transport and the origin:
`remote { transport, peer, origin }` for another computer, `local { actor }` for its own
UI/CLI, and `steward` for its own rules. `sessionHostPromptMarker` produces
`[from Release notes on Studio] `, `[from omni CLI on Studio] `, `[from person on Studio] `, or
`[from Session steward on Studio] ` for anything unattended. Every delivered message carries a
marker. Hard stops (`refuseHardStop`) apply on the execution host exactly as they do locally. No
approval record crosses the wire in v1. A future approval has to be action-, target- and
limit-specific, and negotiated.

## Single execution

`decideSessionHostAdmission(request, fingerprint, facts)` sets the order. Package A reads
`facts` atomically from its durable journal at the final guarded-write boundary. It then persists
the intent and `reservationKey` before any byte moves.

1. The operation id is already recorded. The same `sessionHostRequestFingerprint` means `replay`
   (return the record, even while reconciling). A different fingerprint means
   `operation-conflict`.
2. `reconciling` until a restarted host has reconciled its journal, process incarnations and
   queue.
3. Unattended callers are refused the actions marked "refused" above.
4. Destination steps are admitted only for an owner epoch the host has not reached.
5. `unknown-conversation`, `not-adopted`, `not-owner`, `stale-owner-epoch`.
6. Organization actions need `expectedOrganizationRevision` equal to the host's revision
   (`stale-organization-revision`), so a person's later edit is never overwritten.
7. Turn-fenced actions: `turn-unknown`, then `stale-turn`, then `reservation-invalid` (the named
   reservation no longer holds the turn), then `turn-reserved` (another operation holds it).
   Two Macs that mint different ids for one idle turn get exactly one admission.

Operation states are `admitted`, `dispatched`, `completed`, `refused` (provably nothing was
delivered) and `unconfirmed` (a crash or lost reply made delivery unknowable). An unconfirmed
operation is never resent, and its reservation keeps blocking until reconciliation.
Reservations (`held`, `dispatched`, `settled`, `released`, `unconfirmed`) record their `holder`.
Only the holder may run under a reservation or release it. Transfer and relocation source steps
keep their reservation held after they complete. Later steps name it in `reservation`, and
`transfer.settle-source`, `relocate.relinquish` or `sessionHost.release` ends it. A person's
input before delivery refuses pending automation with `person-input`. Existing drivers refuse
with `has-driver`.

Retry rules (`sessionHostRetryRule`):

- `host-unreachable` and `renegotiate`: repeat the identical request, or query `operation`.
- `stale-*`, `turn-reserved`, `reconciling`, `storage-unavailable`: observe again and send a new
  operation id.
- Every other code, including codes from a newer host that this build does not know: `never`.

The guarantee is one admitted action per turn, with no blind redelivery. It is not exact-once
physical delivery.

## Verdicts

The vocabulary is exactly `live`, `unverifiable` and `exited` (`SESSION_HOST_EXECUTION_VERDICTS`,
checked at compile time against `SessionExecutionVerdict`). Only the owning host's own
observation can say `live` or `exited`. `sessionHostVerdictOf` returns `unverifiable` for a lost
reply, a refusal, a row that is missing or unreadable, or any other value. An unreachable host
means no continue, restart, archive or takeover. Process exit does not mean Done.

## Relocation and waits

- The source records a `SessionHostRelinquishment` and a `SessionHostOwnershipGrant` for epoch + 1
  that is bound to one destination. `sessionHostGrantMismatch` rejects a grant for another host,
  another conversation or a stale epoch. Consumption is durable and single-use. A lost
  acknowledgment never lets the source restart.
- A manifest covers every native file with relative, non-escaping paths
  (`isRelocationManifestPath`) and `sessionHostRelocationManifestDigest`. It never contains
  credentials.
- `SessionHostWaitReceipt.satisfiedBy` names the owner epoch and outcome revision. A deadline or a
  closed transport never satisfies a wait. The client reader maps an unknown state to
  `registered`.

## Organization sync: the `t` document kind

Key: `omni-ide.sync.d.<device>.t.<index>` (`sessionHostSyncDocKey`), with up to 256 documents of
32 KB each per device. Released clients' `parseDeviceDocKey` matches only `f` and `s`, so they
never read or write `t`. Folder and session documents are unchanged.
`session-host-sync-compat.test.ts` runs the real released engine against `t` documents and an
unknown kind to prove this.

The value is `{ v: 1, e: { <entry id>: entry } }`:

| `k`     | Entry id                         | Meaning                                                                                 |
| ------- | -------------------------------- | --------------------------------------------------------------------------------------- |
| `own`   | `own:<session>:<field>`          | Ownership receipt: revision `r`, exact value `v`, op, host                              |
| `rev`   | `rev:<session>:<field>:<op>`     | Permanent revocation; never evicted                                                     |
| `title` | `title:<session>`                | Title origin                                                                            |
| `pol`   | `pol:<folder>`                   | Reduce-only folder policy override                                                      |
| `hist`  | `hist:<op>`                      | Bounded history (20 per session), merged by operation id                                |
| `res`   | `res:<session>`                  | Result reference                                                                        |
| `alias` | `alias:<conversation>:<session>` | Conversation id ↔ session digest                                                        |
| `int`   | `int:<op>`                       | Pending intent. It is never shown as applied, and it is dropped once `hist:<op>` exists |

- Merge by entry id: the later `at` wins, and ties go to the larger canonical JSON.
- An entry of an unknown kind is kept byte for byte in `opaque` and rewritten with the document.
- Known entries keep any extra fields a newer build added.
- A document with `v > 1` is never merged and never overwritten (`mayRewriteSessionHostSyncDoc`).
- A policy override naming a restriction that this build does not know turns automation and
  relocation off for that folder (`effectiveSessionHostFolderPolicy`).
- Sync receipts describe execution. They never grant it, and they never clear an uncertain
  reservation.

## Headless organization (package D)

A host commits organization changes to its own sessions without a window. Every change goes
through the same ledger as the window's (trail line first, then history and ownership), so
history, Undo and ownership read the same whichever applied it. With no window, the ledger's
applied record is the change: the host's values (`<userData>/session-organization/host-values.json`)
are a fold of applied records plus migrated values, so they survive a restart and are rebuilt
from the trail if lost. A record the host applied itself carries `headless: true`.

Code: `src/shared/session-organization-host.ts` (values, fold, the API types),
`src/main/session-organization/host-organization-*.ts` (service, commit, migration, adoption,
values, outbox; Electron-free, so a relay can run them), `src/shared/steward-account-sync.ts`
(the `t` pass) and `steward-sync-main.ts` (main binds it to omnios).

`sessionOrganizationHostFor(userDataPath)` returns the profile's `SessionOrganizationHost`:

- `apply(request)`: a `HostOrganizationRequest` is an `OrganizationChange` without `opId` (pass
  A's `operationId` as `opId`), plus an optional `expectedOrganizationRevision`. The answer is
  `applied` (with `mode` `headless` or `window`, before and after, `revision`, each target's new
  `organizationRevisions`, and `replay` for a repeated id), `refused` with a
  `SessionHostRefusal`, or `failed` when a window refused it.
- `read(keys?)`: `migratedAt`, and per key its values, per-field revisions, the
  `organizationRevision` that `observe` returns, ownership, and interrupted op ids.
- `history(key, { aliases })`: an `OrganizationHistory`, for `sessionHost.history`.
- `undo(opId, { executor, mintOpId, expectedOrganizationRevision })`: the window's Undo. Main
  plans it, each target is read again, and only unchanged targets are put back (`undone`,
  `total`, `skipped`).
- `migrate({ entries, complete })`: imports existing values (below).
- `ingest({ entries, placements, headless })`: other computers' `t` entries and folder stamps.
  Revocations only.
- `outbox.pending()`, `outbox.ack(items)`, `outbox.putRaw(items)`: the durable outbox. A relay
  has no account access, so a connected Mac drains `pending()`, `putRaw`s the items into its own
  outbox, and then the relay `ack`s them.
- `publish(entries)` for `alias`, `res`, `pol` and `int` entries, and `noteDigests(pairs)` for a
  key with no canonical sidebar identity.

Action mapping for A: `rename` is kind `title` (value `payload.title`, `origin`), `archive` and
`unarchive` their kinds, `organize` the payload's `kind` and `value`, and `undo` is
`undo(payload.undoOf, …)`. B derives the executor from `SessionHostAuthority`; the payload never
carries one.

Refusals, in order: `invalid-request` (not a host kind, a target without `sessionKey`, a bad
value, a pane or CLI move without a reason), `not-adopted` (automation before migration
completed; a person is never held back), `reconciling` (an interrupted change on a target),
`stale-organization-revision` (with `current.organizationRevision`), `ownership-conflict` (the
#747 revision check: the person's now, not owned, changed since, or drifted),
`operation-conflict` (an id reused for another change), `storage-unavailable` (nothing could be
recorded first).

- **Where it applies.** While this process has a window, a change goes through it exactly as a
  CLI change does. With none, or when the window is gone, it commits headlessly under the same
  operation id.
- **Migration before automation.** `migrate` takes what a window (or, for an SSH host, a Mac)
  holds. A value never recorded here is imported as found. One recorded differently was changed
  by something that recorded nothing, so the found value wins as an `app/restore` change, which
  takes an agent's ownership back. A placement or title with no provenance (no ownership, no
  revocation; a `generated` title origin counts as provenance) becomes the person's for good
  (`migration/unknown`). Until a migration completes, every non-person change is refused. The
  window hands over its values at every start.
- **Adoption.** A window that opens on a host which committed changes while it was closed
  adopts them before its account sync runs (`sessionOrganization.hostPending`, then
  `hostAdopted`, then `hostMigrate`). Where it holds a value the change did not start from, the
  window's value wins (recorded as a restore). A change whose field another computer took back
  after it is never handed out.
- **Concurrent manual edits revoke** as #747 defines: a person's change here; a restore or a
  window without the revision check; another computer's `rev` entry, or its `hist` entry for an
  owned field after the owned change; and, while no window runs here, an account folder stamp
  this host did not author (an older app), even for the same folder.
- **Sync.** Main publishes the outbox into this computer's own `t` documents (never another
  computer's, never `f` or `s`) five seconds after a change and every five minutes, and ingests
  every other computer's entries. Revocations this computer only inferred (`migration/…`,
  `sync/…`) are not published: a Mac's guess about another host's session must not revoke that
  host's receipt.

## Mixed versions

| Direction                                                                                 | Behaviour                                                                | Fixture                                                                         |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| New client, old paired host                                                               | Every method refused before calling                                      | `legacyRuntimeStatus()` (derived: this build minus the family)                  |
| New client, old relay                                                                     | Nothing negotiated                                                       | `LEGACY_RELAY_PTY_CAPABILITIES` (pinned)                                        |
| New client, old host called anyway                                                        | `method_not_found` / `-32601` becomes `unsupported-capability`           | `session-host-wire-compat.test.ts`                                              |
| Old client, new host                                                                      | Control refused, organization still visible; new answers only add fields | `legacyClientCapabilities()`                                                    |
| New ↔ new, partial host                                                                   | Only mutually agreed capabilities are usable                             | `phase4RuntimeStatus([...])`                                                    |
| New client, host that relocates without `session-relocation.bundle.v1` (a B1/C-era build) | Refused before the source is touched: "update OmniConsole there first"   | `session-host-wire-compat.test.ts`, `session-transfer-relocate-channel.test.ts` |
| New client, relay without relocation (a B2-era relay)                                     | Refused before the source is touched: "update OmniConsole there first"   | `relay-owner-relocation.test.ts`                                                |
| Old ↔ new sync                                                                            | `t` and unknown kinds survive old → new → old, with both real engines    | `session-host-sync-compat.test.ts`                                              |

## Package A: host protocol and admission

The implementation lives in `src/main/session-host/` (Electron-free, so the relay bundles it),
`src/relay/session-host-relay-handler.ts` and `src/main/runtime/rpc/methods/session-host.ts`.

- **One registry per execution account.** `~/.omni/session-host/<machine+user key>/` holds
  `registry.json` (the `hostId`, minted once) and `journal.json` (conversations, operations,
  reservations, grants, live host processes). Every runtime profile and relay version on the
  account opens the same directory; the key uses the machine identity the relay's hook installer
  already uses, because a home directory can be shared across SSH hosts. A machine that cannot
  identify itself durably refuses to own sessions rather than split the registry.
- **Exclusive writer lock.** Each transaction runs serially in its process and under a
  cross-process `proper-lockfile` lock, reads the journal fresh, and publishes it with an fsync'd
  rename. A journal that is unreadable, or written by a newer build (`v > 1`), refuses every
  mutation and is left byte for byte.
- **Admission at the final write boundary.** `admitted` (intent and reservation durable, nothing
  sent) → `dispatched` (written before the executor runs) → `completed` / `refused` /
  `unconfirmed`. When a process that is provably gone left an operation `admitted`, the next
  opener refuses it (`reconciling`) and frees the turn; one left `dispatched` becomes
  `unconfirmed`, is never resent, and keeps blocking the conversation until
  `reconcileSessionHostOperation` settles it from evidence. A live or unverifiable process's
  operations are never touched.
- **Holders.** A held, dispatching or unconfirmed reservation holds the whole conversation. A
  settled one keeps its own turn consumed, so a second Mac echoing the same revision still loses.
  Only the process recorded as a conversation's `controller` acts on it: another live process on
  the account refuses with `ownership-conflict`, and a dead controller's conversations answer
  `reconciling` until the restarted process registers them again.
- **Retention.** Settled operations older than 30 days (or beyond 2,000) are evicted; each evicted
  id raises a horizon, and an id at or below it is refused rather than admitted twice.
- **The send door.** `deliverToConversation` admits every automatic delivery (prompt queue,
  chain turns, Up next, prompt-now) to a conversation the registry has adopted, on its current
  turn. A delivery the host service is dispatching names its operation instead. Conversations the
  registry has not adopted are delivered exactly as before.
- **Transport gate.** The runtime serves paired devices only; its own socket and dispatched
  workers are refused (`provenance-required`), since this computer's own callers use the owner
  service in process. The relay serves its SSH launch channel and authenticated socket clients,
  and needs `sessionHost.declareClient { capabilities, client }` once per connection (`client`
  is the requesting computer's own `hostId`, stable across reconnects); after a reconnect it
  answers `renegotiate`. The desktop declares `SESSION_HOST_CLIENT_CAPABILITIES` on its runtime
  connections.
- **Client side.** `SessionHostClient` (`src/shared/session-host-client.ts`) with
  `runtimeSessionHostTransport` / `sshSessionHostTransport` negotiates before sending, re-probes
  after a reconnect or a reply stamped with a new `runtimeId`, and maps a missing method to
  `unsupported-capability` and a lost reply to `host-unreachable`. `SessionHostOwnerDirectory`
  resolves connections that advertise one `hostId` to one host and moves a conversation's owner
  only on a strictly higher owner epoch.

### Interfaces for B, C, D and E

- **B** implements `SessionHostExecutor` (`session-host-executor.ts`): `capabilities()`,
  `reconciled()`, `readTurn()` (read inside the admission lock), `observe()`, `prepare()` (refuse
  before anything moves, or return `dispatch`), and `tidy` / `history` / `waitStatus`. Install it
  with `runtimeSessionHostProcess(runtimeId).installExecutor(…)` and
  `relaySessionHostProcess().installExecutor(…)`. Register and adopt conversations with
  `registerSessionHostConversation` (one registration per provider identity; `adopted: true` only
  with verified evidence), hold admission closed across its own restart reconciliation with
  `service.holdAdmission()`, settle unknowable deliveries with `reconcileSessionHostOperation`,
  and run this host's own callers through `service.execute(request, { kind: 'local' | 'steward' })`.
  A dispatch that delivers a prompt calls `deliverToConversation` with
  `hostAdmission: { hostOperation }` and starts the text with `input.marker`.
- **C** uses `service.reserve` / `service.execute` with `reservation`, `service.release`,
  `relinquishSessionHostConversation` (atomic tombstone plus one destination-bound grant) and
  `consumeSessionHostGrant` (durable, single use). Completed transfer and relocation source steps
  keep their reservation held by default; a settlement can say `reservation: 'settle' | 'release'`.
- **D** supplies organization revisions (`read`) for `readTurn`/`observe`, and the organization
  actions and `history` through `SessionOrganizationHost` (see "Headless organization"). B's
  executor wires them in and plans `tidy`; `session-organization.host.v1` is advertised only once
  the executor carries them.
- **E** builds `SessionHostClient` on a runtime connection (`sendRemoteRuntimeConnectionRequest`)
  or an SSH multiplexer, feeds negotiations and observations to `SessionHostOwnerDirectory`, and
  renders refusals with `sessionHostRetryRule`.

## Package B1: the owner service on paired hosts

Code: `src/main/session-host-owner/` (started from `src/main/index.ts`).
`SessionHostOwnerExecutor` is installed on the runtime's session host process. Every action runs
through session-manage's own functions (`continueSession`, `queueQuestion`, `answerSession`,
`stopSession`, `restartSession`) or D's `apply`/`undo`, with the actor `sessionHostActor(authority)`
derives. Markers, hard stops, the unattended policy, Keep going and the audit are therefore the
ones a local caller gets.

- **The remote actor.** `SessionManageActor` gains a `remote` kind (`title`, `computer`, `peer`,
  `requester`, `unattended?`), built only in main. Its title is `sessionHostActorTitle`, so the marker
  session-manage writes equals the one admission stamps. It is audited as `actor: 'remote'` with a
  `remote` block. It commits organization as the person (`person/sidebar`), as `cli` for another
  computer's agent, or as `app/steward` when unattended. `SessionHostUnattended` is
  `SessionManageUnattended`.
- **Inventory with no window.** `HostSessionInventory` reads the window's rows while one answers
  and keeps them in `<userData>/session-host/rows.json`. With no window it uses those remembered
  rows, observed live, so a pane nothing here resolves reads `unverifiable`. Only this computer's
  own rows count. The steward's rules loop reads the same rows when no window answers
  (`setStewardRowsWithoutWindow`).
- **Adoption.** Every pass (5 s after start, then every two minutes) registers every local session with
  a provider identity. It adopts only a live one whose agent provably holds the terminal (or whose
  chat is held here) and whose latest turn reads. A conversation the host cannot read stays
  unadopted, and its queued prompts flow exactly as before. One registration per provider
  identity: the live row wins over an old exited pane. An unchanged registration is never
  rewritten. A conversation relocated away is never registered again.
- **Turn revision.** `turn:<digest of the latest finished turn key>`, or `turn:none` when there has
  positively been no turn yet. It is null (so `turn-unknown`) when the host cannot read the turn.
  A delivered prompt does not move it until the agent answers.
- **`continue` / `ask`.** A dry run refuses before anything moves. The real run stamps
  `requestedBy.hostOperation` on the queued entry, and the drain hands it to the send door as the
  named operation. Dispatch waits for the entry: `delivered` is completed. A failure that
  provably sent nothing (`unsent: true`, or never marked sending) is not delivered. Still queued
  after 5 minutes, the prompt is withdrawn unsent. A send that started and does not report within
  2 minutes is `unconfirmed`. An `ask` completes with the reply (`{ outcome: 'answered', reply }`),
  or with a timeout once the question was delivered.
- **`stop`, `restart`, `answer`.** Checked as a dry run, then carried out. A failure after a
  keystroke may have landed is `unconfirmed`. `restart` of an exited session resumes through the
  window when one is attached. Without a window it goes through R2's launcher (same provider
  conversation, new tab).
- **Organization and tidy.** Changes are checked against `expectedOrganizationRevision` before and
  inside `apply`. An unattended caller may only archive, and only a session that passes Tier 2 now
  and that no other session waits on. A wait registered here, or an admitted `wait.register` that
  never settled, both count as waiting. `sessionHost.tidy` runs session-manage's own plan over this
  host's sessions. Each archive is its own `archive` operation, with an id derived from the tidy's
  id, so a retried tidy reports the recorded archives instead of admitting them again.
- **Waits.** `wait.register` records the wait durably
  (`<userData>/session-host/waits.json`) before the receipt goes back. `waitStatus` reports it
  `satisfied` only by the awaited conversation's own result read after registration (owner epoch and
  result revision). A deadline ends it `ended-unmet`. Both are gated on the steward's
  `sessionWaits` switch.
- **Restart.** Until startup reconciliation ends, admission stays closed. Each `continue`/`ask`
  a dead process left `unconfirmed` is settled from its queue entry:
  - delivered: completed
  - provably unsent, never queued, or still queued (withdrawn now): not delivered
  - started sending: unconfirmed until the conversation takes a new turn.
- **Relocated away.** `session restart`, `session resume` and adoption refuse a provider
  conversation this host relinquished, unless it was relocated back
  (`relocatedAwayRefusal`).
- **Switches.** `GlobalSettings.sessionHostControl`:
  - `remoteControls` (off: nothing is advertised)
  - `hostStewardship` (off: every automatic caller is refused `automation-disabled`)
  - `folderPolicies` (a folder with `automation: 'off'` admits no automation; an unreadable
    override reads as off)

  All are on by default. `OMNI_SESSION_HOST_DISABLED=1` stops both. The steward's own switches and
  `OMNI_STEWARD_DISABLED` still gate every unattended action.

## Package B2: the owner service on SSH relays

Code: `src/relay/relay-owner-*.ts`, started by the relay daemon (`relay-daemon.ts`) once its agent
hooks are up. `RelaySessionHostExecutor` is installed on the relay's session host process, so
`pty.getCapabilities` carries `sessionHost` with `session-control.owner.v1`,
`session-waits.remote.v1` and `session-control.delivery.v1` while `OMNI_SESSION_HOST_DISABLED` is
unset. It works with no Mac attached.

- **Evidence.** A pane whose PTY this relay holds is `live`. One it saw exit is `exited`. A pane
  it holds nothing for is `unverifiable`. The agent, its provider session and its state (`done` is
  idle, `blocked`/`waiting` await the person) come from the agent's own hook reports
  (`RelayAgentHookServer`).
- **Turn revision.** `RelayTurnLedger` records each pane's latest `done` report. Its identity is
  the provider's prompt id or the hook's per-turn key, so the revision is null until a finished turn
  is known after the relay starts.
- **Adoption.** The same rules as B1. A pane with a provider session is registered. It is adopted
  only while its PTY lives here, the agent holds the terminal's foreground (its detect command) and
  a finished turn is known. A conversation relocated away is never registered again.
- **`continue`** (prompts only: a relay reads no proposals, so `yes`/`choose` refuse) and
  **`ask`**:
  - The same hard-stop and approval checks as a Mac, and the caller's marker.
  - A prompt goes out only while the agent reports its turn finished and holds the foreground,
    re-proven before the paste and before Enter.
  - A paste whose Enter could not follow is `unconfirmed`.
  - An `ask` completes with the reply the agent's next finished turn carries.
- **`stop`** interrupts a working agent (Ctrl-C, only while it holds the terminal). A pending
  decision needs `force`. **`restart`** unsticks a working agent silent for 10 minutes. An exited
  conversation is resumed from a Mac, which opens the tab. **`answer`** is refused: a relay has no
  screen model to read the question from.
- **Automatic callers.** An unattended caller never prompts, stops or restarts a session on a
  relay (it keeps no prompt limits), and nothing on a relay archives. The relay's mechanical
  steward only reports: a working agent with no report for 10 minutes carries `stalled` on its
  observed entry. The steward's hard stops apply to every prompt.
- **Waits.** Held in `~/.omni-relay/session-host/waits.json`. They are satisfied only by the
  awaited pane's next finished turn after registration.
- **Restart.** A delivery a dead relay left `unconfirmed` is settled as delivered once its
  conversation takes a new turn. Until then it keeps fencing the conversation.
- **A Mac's own writers (`deliver`).** For a pane on an SSH host whose relay advertises
  `session-control.delivery.v1` and has adopted the conversation, `deliverToConversation`
  (`ssh-session-host-delivery.ts`) sends this Mac's automatic writes through
  `sessionHost.execute` `deliver`: its queue, Keep going, chains, Up next and the steward's prompts.
  - The request carries this Mac as origin, names the writer, and is unattended for Keep going and
    the steward.
  - The relay admits it on the conversation's turn like any other writer, writes the exact text
    under the same idle and foreground proof, and applies the hard stops to an automatic writer.
  - A refusal comes back unsent (`SessionHostDeliveryRefusedError`). A lost reply is unknown and
    is never resent.
  - An older relay, a relay that does not advertise delivery, a conversation it has not adopted,
    and every local pane keep today's path. A person typing is never routed.
- **Not on a relay yet.** Organization (it stays with the Macs, and is not advertised) and
  transfers (a relay gives no briefs). Moving a conversation away from a relay is package B3.

### Interfaces for C and E (from B1)

- **C** plugs transfers and relocation in as a `SessionHostActionHandler` (`capabilities()`,
  `handles(action)`, `prepare(input)`, optional `reconcile()`), built by
  `startSessionHostOwner({ actionHandlers: (owner) => [...] })`. `owner` is a
  `SessionHostOwnerContext` (`session-host-owner-context.ts`) with `actorOf`, `readTurn`,
  `archive`, `store` and `ask`. `src/main/index.ts` passes `runtimeSessionTransferHostActions`.
- **E** renders:
  - refusals: `hard-stop`, `unattended-restricted`, `has-driver`, `automation-disabled`,
    `stale-organization-revision` (with `current`) and `person-input`
  - operation results: `continue` `{ entryId, deliveredAt, door }`; `ask`
    `{ outcome, reply? }`; `stop`/`restart` `{ summary }`; organization
    `{ revision, organizationRevisions, mode }`; waits `{ receipt }`
  - the `unverifiable` verdict for a registration with no pane here
  - from an SSH relay (B2): `answer`, `restart` of an exited session, `yes`/`choose` and
    organization refuse with a plain reason, and an observed entry may carry `stalled`

  E owns the Settings rows for `sessionHostControl` and syncing `folderPolicies` between Macs.

## Package B3: moving a conversation away from an SSH relay

Code: `src/relay/relay-owner-relocation.ts`, installed with the relay's owner service. The relay
runs package C's relocation steps (`sessionTransferHostActions`) as a source only.

- **Advertised.** `session-relocation.claude.v1`, `session-relocation.codex.v1` and
  `session-relocation.bundle.v1`, only while the handler is installed and relocation
  (`OMNI_RELOCATION_DISABLED`) and remote controls (`OMNI_SESSION_HOST_DISABLED`) are on on the
  relay. The bundle calls are the shared gate's, which `RelaySessionHostHandler` already serves.
- **Freeze.** Only an idle conversation whose agent the relay proves holds its terminal (the
  `pty.readAgentProcessEvidence` proof). Its process group is signalled
  (`session-transfer-process-group.ts`, shared with a paired runtime); nothing is typed. Exit
  evidence: no agent process under the terminal, only a shell in front, and the signalled group
  gone.
- **Export.** Under the relay's own session host root (`relocations/<id>/export`). The transcript
  is found in the relay user's provider homes (`locateTranscripts`), and only exactly one copy is
  accepted. The manifest, digest, credential and link refusals are a Mac's.
- **Relinquish.** After it, the tombstone refuses every action here and adoption never registers
  the conversation again. The pane keeps its history (a relay has no organization to archive in).
- **Automatic callers.** The relay refuses them every move step (`unattended-restricted`);
  `omni session relocate` only proposes a move for them, before any host is asked.
- **Destination: refused.** A relay refuses `relocate.prepare-destination` with a plain reason,
  and `omni session relocate --to ssh:…` refuses before any host is asked. A relocation takes that
  step before the source freezes, so nothing changes. `omni session hosts` says an SSH host "moves
  its conversations to a Mac".
- **Gap.** Moving the same conversation to an SSH host needs a Mac-driven resume: after staging,
  the Mac opens the destination terminal on the relay through the existing session-launch path, so
  it runs where a Mac shows it. Handing the work to a new session on an SSH host already works
  (`omni session handoff`, phase 1c).

## Package C: transfers and relocation

C's execution-host steps live in `src/main/session-manage/session-transfer-*` (Electron-free,
except the `session-transfer-runtime-*` wiring for this computer's panes). The provider bundles
are in `src/main/session-relocation/`.

**The handler.** `sessionTransferHostActions(deps)` returns
`{ capabilities(), handles(action), prepare(input) }`, the `SessionHostActionHandler` shape that
B's executor delegates `transfer.*` and `relocate.*` to. It adds `reconcile()` for B to run while
it holds admission closed after a restart. `runtimeSessionTransferHostActions(wiring)` builds it
for a paired runtime. B supplies four things in the wiring:

- `actorOf(authority)`, the actor an authority acts as;
- `readTurn`, the turn revision admission reads;
- `archive`, one archive through D's `apply` under the step's operation id;
- `store()`, the host service's store.

Advertising follows the deps. `session-transfer.remote-source.v1` is advertised when the host can
give briefs. `session-relocation.<provider>.v1` is advertised per provider only while relocation
is on and both halves are present.

**Handoff and consolidation from session hosts.** `transferSessions` takes `hostSources` (a
`SessionTransferHostPort` plus a `conversationId` each) beside this computer's own sources.

- Each hosted source is reserved at its own host in canonical `(hostId, conversationId)` order
  (`reserve`, action `transfer.prepare-source`).
- `transfer.prepare-source` asks the source for its brief under that reservation. The step
  completes with `{ transfer, brief, checkpoint }` and keeps the reservation held.
- Right before the target gets anything, the orchestrator observes each source again. The brief
  is sent only if the source is still at its `checkpoint` and still holds the transfer's
  reservation.
- After the target's exact acceptance, `transfer.settle-source` (`accepted` plus the target
  receipt) archives each source at its own host. Otherwise the step (`abandoned`) releases it.
- Each hosted source gets its own receipt (`SessionTransferResult.hostSources`): `archived`,
  `kept` (unarchived and released), `released` or `unresolved`.
- `unresolved` means its host did not answer, so the source is left untouched. The transfer's
  record (`SessionTransferHostRecord`) keeps every request exactly as sent, and
  `HostTransferSources.resume(...).settle(...)` finishes it later with the same request. It never
  asks for a brief again.
- A lost reply is followed by `sessionHost.operation`. A `found: false` answer from a reachable
  host is the only case in which the identical request is sent again.

**Relocation.** `relocateConversation(deps, input)` is its own explicit operation. An unattended
origin only ever gets `proposed`. The requesting computer's switch (`OMNI_RELOCATION_DISABLED`, or
the setting through `configureRelocationSwitch`) and the destination's switch each refuse before
anything is touched. The phases run in this order, and each is recorded before the next is sent
(`SessionRelocationRecord`):

1. `relocate.prepare-destination` checks four things on the destination: its provider CLI version
   (not older than the source's); the workspace (git at the intended commit and clean, or an
   existing folder); an account with capacity (the balanced launch account, never the source's
   credentials); and the switch. It answers `stagingDir`.
2. `reserve` (action `relocate.freeze-source`) takes the source's reservation.
3. `relocate.freeze-source` stops the provider. On a paired runtime it sends SIGTERM to the
   verified idle agent's process group. It proves exit from the process table: no agent is left
   under the terminal, and that process group is gone. Anything short of proof comes back as
   `frozen: false`, and the move is abandoned.
4. `relocate.export` makes a checksummed snapshot of the native files (see "Bundles" below) and
   answers the manifest and its `exportDir`.
5. The requesting computer copies the files through a `SessionRelocationBundleChannel`. Staging
   re-verifies every byte, so the channel can fail but cannot corrupt the bundle. Between two
   computers the channel is `sessionHostRelocationChannel()`: `sessionHost.relocationBundleRead`
   on the source and `sessionHost.relocationBundleWrite` on the destination
   (`session-relocation.bundle.v1`, `src/shared/session-host-relocation-bundle.ts`).
   - Chunks are 256 KiB of base64. A write reports how much of the file the destination holds, and
     a copy resumes from there.
   - Only the peer that ran that relocation's export may read it, and only the peer that prepared
     the destination may write. Paths stay inside the bundle, credential-shaped names and links
     refuse, and nothing is written after staging.
   - Before anything moves, even in a dry run, both hosts are asked through these calls. A host
     that cannot answer them is refused with "update OmniConsole there first", and the source is
     never frozen.
6. `relocate.stage` imports the bundle without launching anything and never overwrites a
   different file. It refuses a transcript written by a newer provider version than the
   destination's CLI.
7. `relocate.relinquish` writes the tombstone and one grant for epoch + 1. The requesting computer
   saves the grant before it sends anything else.
8. `relocate.resume` re-reads the staged files and consumes the grant durably and exclusively
   (`consumeSessionHostGrant(…, consumer)`: a second operation presenting the same grant is
   refused). It then resumes through `omni session resume`'s launch. Work is accepted only after
   the provider itself reports the same id. A different or unreported id is `owned-unconfirmed`,
   and nothing is delivered to it.

Until relinquishment, stopping a move releases the source's reservation (`abandoned`), and the
source keeps the conversation. After relinquishment the source never runs it again: admission
answers `not-owner`, and B's restart and restore adapters refuse a registration with
`owned: false`. If a host does not answer, the move is `blocked`. Continuing it
(`input.relocation`) resends only the recorded requests, so a lost acknowledgment is answered by
the host's own record.

A crash between relinquishing and recording it leaves the step `unconfirmed`. `reconcile()`
settles it from the journal: an issued grant means it relinquished (and the record gains the
grant), and no grant means the source still owns the conversation.

**Bundles.** Manifest paths are relative and non-escaping. Symlinks refuse, and any path segment
named like a credential refuses (`.credentials.json`, `auth.json`, `settings.json`,
`config.toml`, keys, tokens and similar), so credentials never enter a manifest or a bundle.

- **Claude:** `<id>.jsonl` plus its `<id>/` artifacts, filed under the encoding of the
  destination workspace's path. The resume identity is checked with `selectClaudeResumeIdentity`
  with no fallback.
- **Codex:** the one dated `sessions/…/rollout-…-<id>.jsonl`, uncompressed only. The resume is
  checked with `prepareCodexSessionResume`, trusting only the destination home, and a `fresh`
  answer is refused.

Transcripts must parse whole, end on a complete record and name the conversation. Anything else is
refused as incomplete or untested.

Step results are action-specific `result` objects: prepare-destination, `stagingDir` and
`workspacePath`; export, `manifest` and `exportDir`; relinquish, `grant`; resume, `resumed`,
`ownerEpoch` and `binding`. Readers use only the fields they know and treat a missing success flag
as not done.

## Package E: the requesting side (product integration)

Code: `src/main/session-host-remote/` (started from `src/main/index.ts`),
`src/main/runtime/rpc/methods/session-manage-remote.ts`, `session-hosts-status.ts`,
`src/shared/session-host-policies.ts`, `src/shared/session-hosts-status.ts`, the Work card
`WorkOtherComputersSection`, Settings › Other computers (`SessionHostSettingsPane`) and the
folder menu's `SessionFolderAutomationItem`.

- **Controls on another computer's session.** `sessionManage.continue|ask|answer|stop|restart` on
  a row whose `hostId` is `runtime:<env>` or `ssh:<target>` go to that computer
  (`remoteSessionManage` → `runRemoteSessionAction`): one `SessionHostClient` per host key
  (`callRuntimeEnvironment` for a paired runtime; `getActiveMultiplexer` plus the SSH provider
  authority as the connection id and this Mac's own host id for a relay), `observe`, match the
  conversation (its pane, else its tab, else exactly one registration of its provider id),
  check the action's capability, fence on the owner's epoch, turn and organization revision,
  `execute` once. A lost reply is followed by `sessionHost.operation`; only a reachable host's
  `found: false` sends the identical request again. `completed` is done; `admitted`,
  `dispatched` and `unconfirmed` are reported as not confirmed and never resent. Every refusal
  is the host's `message` plus what its retry rule means; an older (`peerStatus` not
  advertised), unreachable or controls-off host is refused before anything is sent.
- **This Mac's rules first.** An unattended caller (the steward, an automatic cleanup session,
  any actor with an unattended context) is refused before a host is asked: each computer's own
  steward looks after its own sessions. A `remote` actor is never forwarded. The origin is this
  computer's name and the pane or CLI that asked, with the person's `--request` and `--reason`.
- **Stop keeps its old path** where the host offers no owner control (`unsupported-capability`
  or a conversation it does not list): an SSH pane's interrupt through its relay. Rename and
  archive of a remote row are unchanged (window organization).
- **`sessionHosts.status`** (window and local CLI only; `omni session hosts`): one snapshot per
  other computer in the sidebar: `checking`, `unreachable`, `older`, `controls-off` or `ready`,
  the agreed capabilities, and counts from that computer's own `observe` (total, by verdict,
  working, needs you, stalled). It answers at once and reads stale hosts in the background (at
  most every 60 s, 3 at a time); `wait: true` waits for that reading. The Work card shows one line
  per computer, never one per session; a relay's steward shows only as `stalled`.
- **Overrides between Macs.** `sessionHostControl.folderPolicies` (by folder id, the same on every
  Mac) and `hostPolicies` (by another computer's registry host id) are published as `t`
  document `pol` entries (`<folderId>`, `host:<hostId>`); each Mac reads every other's on each
  account sync pass (`onStewardSyncEntries`). Each override is one account-wide value: the
  newest entry from any Mac wins, and switching one back on is a newer empty policy. The host
  enforces `effectiveSessionHostControl`: its own switches, the account's folder overrides, and
  the account's switch for its own host id (automation off → `hostStewardship` off). An
  unreadable override reads as off. A host confirms a switch set on it with `ack:<hostId>` (same
  policy, same `at`); the Mac that set it reads it `pending` until then, however long the host
  is unreachable. `<userData>/session-host/policies.json` keeps what was published and read.
- **Switches.** `remoteControls` is this computer's answer as a host. It does not govern a
  session an SSH relay runs: this Mac's own automatic writers (queue, Keep going, chains, the
  steward) reach an adopted SSH conversation through the relay's `sessionHost.execute` whenever
  the relay advertises `session-control.delivery.v1` (B2), and that follows the relay's
  `OMNI_SESSION_HOST_DISABLED`, because the relay owns that conversation's admission.
  `sessionHostControl.relocation` (on by default) feeds `configureRelocationSwitch`.
  Moving a conversation between computers is not offered yet
  (`CROSS_COMPUTER_RELOCATION_UNAVAILABLE`, the one place that says so; E2 adds the bundle
  channel and `omni session relocate`).

Not in E: the relay-side routing of this Mac's own automatic prompts to an adopted SSH
conversation (B2), and moving a conversation between computers (E2).

## Package integration points

- **A, host protocol and admission.** A implements the `SESSION_HOST_RPC` handlers on runtime RPC
  and the relay, validating with the strict schemas and gating with
  `negotiateSessionHostCapabilities({ side: 'host' })`. A adds the names to `RUNTIME_CAPABILITIES`
  and the relay `sessionHost` field only once the handlers exist, and adds optional
  `RuntimeStatus.sessionHost`. It calls `decideSessionHostAdmission` at the final write boundary
  (`session-outcome-conversation-turn.ts`, `conversation-write-fence.ts`,
  `session-guarded-write.ts`, the relay's equivalent), persisting before dispatch. A owns the
  durable journal, the reservations, the grants, and the host/user ownership registry that mints
  `hostId` and `conversationId`. A also adds a section to remote-wire-compatibility.md when it
  advertises.
- **B, host controls and steward.** B's owner service takes `SessionHostAuthority` plus a request
  or an in-process call. It enforces unattended policy (stricter wins), hard stops, `has-driver`
  and `person-input`, and delivers with `sessionHostPromptMarker`. B fills in observations
  (verdict, turn revision, admission) and implements the wait receipts. When S1 merges, alias
  `SessionHostUnattended` to `SessionManageUnattended`.
- **C, transfers and relocation.** C uses `reserve` and `execute` with `reservation`, the
  `transfer.*` and `relocate.*` payloads, the manifest and its digest, grants and
  `sessionHostGrantMismatch`. C acquires reservations in canonical host/conversation order and
  never resends an accepted source.
- **D, organization and sync.** D implements `rename`, `archive`, `unarchive`, `organize` and `undo`
  against revisions, plus `history` and the `t` document (see "Headless organization"). For the
  `t` document, D uses `parse`/`merge`/`bound`/`layout` from `session-host-sync-doc.ts` and
  writes only its own device's shards. D keeps `f` and `s` unchanged. `tidy` plans with B's
  eligibility and commits each archive through `apply`.
- **E, product integration.** E negotiates on the client side before showing a remote action. It
  renders `refusal.message`, applies `sessionHostRetryRule`, uses `sessionHostVerdictOf` for
  partitioned hosts, and uses `ref` for show. Where a host does not support something, E explains
  it and never substitutes a local action.

Run the contract tests with:

```bash
pnpm exec vitest run --config config/vitest.config.ts src/shared/session-host-*.test.ts src/renderer/src/lib/account-sync/session-host-sync-compat.test.ts
```

Package D's tests: `src/main/session-organization/host-organization-*.test.ts`,
`src/shared/session-organization-host.test.ts`, `src/shared/steward-account-sync.test.ts`,
`src/renderer/src/lib/session-organization-host-*.test.ts` and the compat test above. The two
`*-parity.test.ts` files run one scenario through the window and headless, against one expected
history (`session-organization-host-parity-fixture.ts`).
