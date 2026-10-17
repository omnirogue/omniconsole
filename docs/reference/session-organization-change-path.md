# Session organization change path

Every change to how sessions are organized (a move, archive, delete, re-title, tag, hide,
snooze or folder edit) goes through one path that records who made it, why, and whether it
really happened. The record is what later decides whether a placement or title is yours or the
steward's, and what Undo can safely put back. Code: `src/shared/session-organization-change.ts`
(contract), `src/main/session-organization/` (history, trail, reconciliation, relay),
`src/renderer/src/lib/session-organization-change.ts` (the window's one entry point).

## The record

`OrganizationChange` is one change: `opId`, `kind`, `targets[]`, `value` (or per-target
`values[]`), `executor`, and optional `origin` (titles), `reason`, `request` (the person's own
words), `evidence`, `expectedRevision` and `undoOf`. Many targets are **one** change with one
reason: one prepared and one applied record, and one Undo. `OrganizationRecord` adds `phase`,
`ts`, per-target `before[]`/`after[]` (aligned with `targets`, never partial), `revision`,
`error`, `reconciled` and `revisionUnchecked`.

Values by kind: `move` a folder id (`saved-sessions` for the Saved root, null for unfiled);
`archive`/`unarchive`/`delete`/`hide`/`unhide` the resulting boolean; `snooze` the wake time or
null; `tag`/`untag` the tag id, with each target's before/after being whether it has that tag;
`title` the text; folder kinds their fields; `folder.project` a project's settings, or null
when they are removed (a `folder.create` that made a project carries them too). A relayed CLI
move is prepared with the folder reference it named; its applied record carries the resolved id.

## Executors

| Executor                                                               | Who                                       | Proven                                             |
| ---------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------- |
| `person` (`via` sidebar, work, notice, pane-rename)                    | the person, in this window                | yes (the window)                                   |
| `pane` (`paneKey`, `title`)                                            | an agent session, by its launch evidence  | yes                                                |
| `cli`                                                                  | the local CLI without pane evidence       | no                                                 |
| `launch` (session-prep, terminal-create, session-launch, worker-start) | filing a session it just launched         | claimed; the trail keeps the actor that claimed it |
| `sync` (`stamp`)                                                       | another device, through account sync      | no: actor unknown                                  |
| `app` (auto-archive, key-migration, transfer, finish, restore)         | the app itself                            | yes                                                |
| `app` (`steward`)                                                      | the session steward, unattended (Phase 2) | yes: main only                                     |

The schema is closed: the window's records accept `ORGANIZATION_WIRE_APP_FEATURES`, which leave
out `steward`, so no caller can claim it. Only main records a steward change, and an unattended
actor may only archive, each target passing Tier 2 first. See
[`session-steward.md`](./session-steward.md).

## Phases

- **Person:** apply first, record after (`applied`, best effort). A record failure never undoes
  the change; the window shows a toast.
- **Everyone else:** `prepared` is written before the change runs; if it cannot be written the
  change is refused ("no record, no change"). Then `applied` or `failed` (`no-window` when no
  window could apply it).
- **Trail first:** every phase is one line in `<userData>/session-actions.jsonl` carrying the
  whole change; `applied` records then enter `<userData>/session-organization/history.json`
  (temp file, fsync, rename). A crash between the two is repaired from the trail at the next
  start; applied lines older than the history's newest entry were pruned, not lost.
- **Reconciliation:** a `prepared` line with no terminal phase is held as pending: no ownership,
  no Undo, and new non-person changes to that target are refused. Once the window's sessions are
  restored it calls `sessionOrganization.reconcile`; main asks the window (`probeOrganization`)
  whether each target holds the intended value: yes → `applied` with `reconciled: true`,
  otherwise (or can't tell) → `failed: interrupted`. With no window, they stay pending.

## History, ownership, revisions

- Per key (session view key, or `folder:<id>`, `pane:<key>`, `tab:<id>` before resolution): the
  last 50 applied records. Past 5 MB the oldest rolling records go first; ownership receipts and
  revocations are never pruned.
- `revision` of an applied change is its `opId` (`sync:<stamp>` for sync). A target's current
  revision for a field (placement, archived, hidden, tags, …) is the newest record touching it.
- `mayEstablishOwnership(record)`: applied, revision-checked, placement or title, by a
  non-person executor other than sync, key migration or restore. A person's applied placement or
  title change writes a permanent revocation (`revocationFor`).
- `sessionOrganization.undoPlan` returns the inverse for targets whose current revision is still
  the change's, and reports the rest as `changed-since` (or `not-undoable`) with `partial`. The
  window re-reads each target before applying, so a change made by a path that does not record
  yet is also skipped, never overwritten.

## Ownership

Only an agent's own untouched change counts as its own. The rules live in one place,
`src/shared/session-organization-ownership.ts`, used by main's history store (authoritative) and
by the window's mirror (`store/session-organization-ownership.ts`, per device and account scope),
so both reach the same answer from the same record:

- A revision-checked non-person change owns the placement or title it changed, with its value and
  revision. A change that left the value as it was owns nothing.
- A person's change revokes for good: no later agent change owns that field again. Sync from
  another device, a restore, or a window that skipped the revision check takes back ownership it
  finds, even when the value ends up the same; key migration carries it and makes none.
- Sync: the pass that authors a stamp notes it on the owned change (`noteAuthoredStamps`); the
  hook in `applySynced` hears every stamp before the equal-value shortcut. Our own stamp (the
  noted one, or one this computer authored for an owned change recorded after it synced) is an
  echo; any other stamp revokes (X → Y → X on another Mac, or an older app). Every change a pass
  applies is recorded as `executor: sync`, after it happened, like a person's.
- Changes made signed out or offline have `revision = opId` until they sync.
- 1a batch filings are seeded as `{ by: 'launch', revision: 'seed:<batchId>' }` only where the
  session still sits in its batch folder and nothing is recorded for its placement.
- A pane's history and ownership move to its provider key with the folder that key keeps; every
  revocation of either key stays.
- Revision check: a non-person change naming `expectedRevision` is refused unless each target is
  still owned at exactly that revision and still holds that value (window, `checkOwnedRevision`);
  main refuses a stale one in `prepare` too, for every field (non-owned fields: newest change).

Later phases: read `ownership[field]` from `sessionOrganization.ownership` (main; window or local
CLI) or `ownedField(key, field)` on the mirror; a field without ownership is the person's. Pass
that ownership's `revision` as `expectedRevision`. `sessionOrganization.syncStamps`, `migrateKeys`
and `seedOwnership` accept only this computer's window.

## Required reasons

`moveSession`/`moveFolder` (kinds `move`, `folder.move`) and `tag`, `untag`, `hide`, `unhide`
and `snooze` from a `pane` or `cli` executor need a reason, once per change however many
targets; `--dry-run` is exempt. `omni session organize --apply` needs one for the whole plan. Launch filing records
`filed at launch from request "<excerpt>"` (or `filed at launch`).

## Wire and compatibility

All new fields are optional. `sessionFolders.mutate` takes `opId`, `origin`, `expectedRevision`
and `launch`; main relays `{ kind: 'mutate', op, change }` and a window that understood `change`
answers with `organization` (resolved targets, before, after). An older window ignores `change`:
main records the change `applied` with `revisionUnchecked` (no ownership). An older main sends
no `change`: the window records the change itself as `cli`, best effort. A newer CLI filing a
launch against an older runtime retries without `launch`. One change for many targets travels
as `{ kind: 'applyOrganizationChange', change }` (main: `relayOrganizationChange`); a window
that does not answer it is recorded as failed, having changed nothing.

`sessionOrganization.prepare`, `settle` and `reconcile` accept only this computer's desktop
window; `history`, `recent` and `undoPlan` also answer the local CLI; paired devices are refused.

## What later packages add

- **Ownership (WP-B):** the renderer mirror, `setOrganizationRevisionCheck` (the default allows),
  the sync hook before the equal-value shortcut, sync stamps on ownership, key migration and
  seeding from batch origins.
- **Titles and readers (WP-C):** title origin at every title path, `omni session history` and
  `omni session actions`, the History tab and Steward activity card, and the skill.
- **Appliers:** the window applies `move`, `archive`, `unarchive`, `delete`, `folder.move`,
  `folder.rename`, `folder.color`, `folder.project`, `title`, `tag`/`untag` (value: the tag id;
  a relayed change may name it), `hide`/`unhide` (the row's `conversation:<key>` in the hidden
  list) and `snooze` (the wake time in the wait store under `conversation:<key>`, kept across
  restarts).
- **Titles (WP-C):** a title change targets the tab (`tabId`) and, when listed, its row's
  `sessionKey`; its value is the words, its `origin` whose words they are (`yours`,
  `generated`, `unknown`), also kept on the tab (`customTitleOrigin` / `customLabelOrigin`).
  The sidebar and tab-strip renames and "Rename from their goals" are the person's;
  `omni session rename --origin` is prepared by main; `omni terminal rename` and
  `session launch --title` (`--title-origin`) are prepared by the window. A tab
  `terminal create --title` names is recorded as `launch`/`terminal-create` with its origin
  (never yours; a refused record still names the tab), on the renderer-backed and the reveal
  create path alike. The pane header rename is the person's (`pane-rename`, yours), recorded
  without before/after so its Undo never writes the tab's title. Other creators (default tabs,
  workflows) store a generated first title and record nothing. The
  readers are `omni session history` (`sessionOrganization.history` by key plus alias keys,
  or by pane/tab), `omni session actions` (`sessionOrganization.actions`, the whole trail) and
  `sessionOrganization.recent` for the Work page's Steward activity card; `history` and
  `recent` also return the `undoable` opIds.
- **Reroutes (done):** every sidebar, bulk, row-menu, folder, finish, transfer, automatic-archive
  and launch-filing change goes through the path, and so do the person's tag, hide and snooze
  (row and fleet-row eye, bulk Hide/Show, tag picker, Work's bring-back): the person's through
  `session-organization-person-changes.ts`, the app's and launch filing's through
  `session-organization-app-changes.ts` (prepared first, running the store action that keeps its
  receipt, proof or archive origin). A CLI change's toast Undo uses `undoOrganizationChange`, or
  the folder-tree snapshot for folder create/delete/reorder. `session-organization-change-path-boundary.test.ts`
  fails when a file outside the path calls a folder, view, hidden-list (`setHidden`,
  `setHiddenMany`), snooze (`snooze`, `setUntil`) or tag-store (`save`, `migrateSessionKey`)
  mutator directly; its allowlist names the files that record elsewhere (relayed CLI ops, sync
  and key migration) or change what no kind names (a whole group's or a routine's hiding, tag
  definitions, pane and card waits). The tag filter is a view: `setFilter`.

## Headless commits (Phase 4)

An execution host with no window (an SSH relay, a runtime whose window is closed) commits
changes to its own sessions through `SessionOrganizationHost` (`host-organization-service.ts`).
The ledger is the same; the applied record is the change, marked `headless: true`, and the
host's values are a fold of applied records. Automation waits until the window's (or a Mac's)
values and provenance are migrated: anything without provenance becomes the person's. A window
that opens later adopts headless changes before account sync runs, and its own value wins where
it differs. The contract is in [session-host-control.md](./session-host-control.md#headless-organization-package-d).

## Bulk organize

`omni session organize|tag|hide|unhide|snooze` call `sessionOrganization.organize` (local CLI,
pane evidence). Main plans against the sidebar rows it reads: unknown panes, no-ops, and a hide
or snooze of a session asking the person (`awaiting-user`, `waiting-for-yes`) are skipped with a
reason; a dry run reports the five-line focus estimate (`session-organize-focus.ts`, counted with
the focus view's own ranking in `src/shared/session-focus-ranking.ts`, so "lines after" is what
the sidebar will show) before and after, and returns the plan with each session's current revision as `expectedRevision`. Applied,
it creates planned folders through `sessionFolders.mutate`, re-checks each target's revision,
prepares one change per kind (all targets, per-target `values`), and relays them together as
`{ kind: 'applyOrganizationChanges', changes }`; the window answers per change and shows one
notice whose Undo undoes them all. An older window answers nothing: every change is recorded
failed.

`artifact-review` is a main-only app executor, like `steward`: a Reject on a review page deletes
the session that asked (`deleteSession` with `purge`, which skips Recently closed), and a page closed
without a decision archives it. Both go through `relayOrganizationMutation`, so each is recorded
prepared → applied/failed with the page, revision and decision as its reason and evidence.
