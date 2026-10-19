# Completed sessions and automatic archive

Ordinary conversations stay open when an agent finishes answering. Automatic
Done archiving requires an explicit **When finished: End** choice, as installed
by `omni session launch --ephemeral` for disposable agent work, or an **agent
session**. A missing choice, Keep open, Save, and an outcome-only finish
preference never qualify a person's session for this background archive path.
Clearing the choice cancels its Done clock. Existing finite orchestration
workers still use their accepted-result cleanup contract.

## Agent sessions and the person's own

Sal, 19 Oct 2026: "agent sessions [are] separate from human sessions and human
started sessions stay open until we close them." A session is an agent session
when an agent launched it: `omni session launch` (and so `omni-models` and a raw
OmniOS launch), an OmniOS/MCP launch through session prep (the connector path
only; a person's own "create sessions for…" prep is theirs), or an orchestration
worker that `worker-start` created. The computer that runs it keeps the note
(`agentSessions` in the session folder metadata, moved with the session key)
and its conversation ledger carries `agentSession: true` to paired computers.

- The sidebar lists agent sessions in **Agent sessions**, folded by default,
  below the person's own sessions, projects and Saved, wherever the launcher
  filed them; they no longer count in that folder, and a batch folder only
  agent sessions fill leaves the view. One that needs the person is in Needs
  you. One the person saves, or files anywhere themselves, is theirs.
- `omni session list --json` rows carry `agentSession` (true or false);
  orchestration workers count as agent sessions there too.
- Only agent sessions are cleaned up unasked: the Done archive above, the
  steward's blank-session close (a person's blank session is never vouched
  for) and its Tier 2 finished-session archive, and `omni session tidy
  --apply`, which holds a person's session that would otherwise be archived
  unless the request names it with `--include`.

The Conversations clock menu has two independent controls: **Fold idle groups**
(presentation only), and **Archive completed sessions**. Archive defaults to two
hours continuously Done, has Off, preset delays and a custom 1–43,200 minute
delay. Preferences and completion clocks are persisted per device/account using
the existing sidebar view storage. Changing the archive setting starts a new
delay; it never changes the fold setting or sweeps old sessions immediately.

## Done, bells and completion

Done is the sidebar's idle/finished-turn group, not proof that the full request
was delivered. The bell specifically means **Unread agent completion**. Questions,
permissions, approvals and outcome attention have separate Needs you states.
Both unread completion and current attention block automatic archive. Historical
answered questions do not permanently block a later completed turn.

A clock exists only for an identified, unique, available Done session with no
bell, attention, snooze, background work, failed/interrupted state or launch.
Saved sessions/folders, Save or Keep open finish choices, pinned tabs/worktrees,
deleted sessions and explicit Unarchive keep-visible overrides are protected.
Missing host state, ambiguous identity and unreadable storage never mean finished.

The revision includes account scope, provider/row/workspace/host identity, agent
activity and outcome revision. New activity, attention, a reopened plan, unavailable
host or protection removes the clock. Returning to eligibility starts it again.
Clocks survive restart only when the same identified state is observed again.
No clock is backdated from a self-described completion sentence. Clock rollback
resets the delay. Hidden/inactive tabs use the existing application finish tick,
not a component-local timer in the active conversation.

## Evidence paths

The verified-outcome path retains its completion seal and fresh owning-host
Up next read: every requested condition's exact revision-bound receipt, settled
attempts, no held continuation, unfinished sibling, draft, queue, required review
or waiter. Merged PRs alone do not prove deployment, verification or follow-through.
Old/disconnected hosts return no proof.

The everyday path (Sal, 27 Sep: idle with nothing pending counts as Done) is for
a local conversation with **no outcome plan**. The window's Done clock must have
run continuously for the delay, as above. Then the owning host's Up next read
must report `idleArchiveClear`. That means no chain of any state for the row, a
finished turn with no pending question or permission prompt (`finishReady`), and
no busy agent, background work, queue, draft or held prompt. It also needs no
proposed next steps (waiting-for-yes), no Keep going and no session waiting on
it. Hosts that omit the field never qualify. The receipt is `advisory:idle` plus
the Done clock token, and the audit reason is "Continuously Done, idle, nothing
pending (no plan)". The final synchronous check re-reads the clock evidence and
refuses when a plan appeared or the row is not local. Any later status report,
a plan, a pin or a save brings the row back. A conversation with a plan never
takes this path.

The existing local session steward provides the non-code path. It checks current
execution, prompts, proposals, questions, held deliveries, recorded commitments,
waiters and the same persisted Done clock. Then a bounded JEV archive review reads
the recorded goal, latest request and the complete latest answer. The recorded
goal can be a task or this host's first observed prompt; it is not asserted to be
the conversation's original request. A missing latest request, an acknowledgement
without the full goal, or missing earlier context keeps the session visible. Its closed choices
distinguish an actually delivered answer from external delivery, work left, a
question, a wait and unknown evidence. Separate outstanding-obligation and coverage
questions must also pass. A finished turn, promise or bare "done" does not qualify.

An answer that itself supplies the requested explanation or draft can qualify.
A claim about external delivery needs deterministic verified completion records.
Referenced PRs must have available merged facts; missing/open/closed-unmerged PRs
block. JEV never authenticates GitHub, grants permissions, changes an attention
record or substitutes its confidence for measured accuracy. Missing, incomplete,
oversized, unavailable or ambiguous semantic evidence stays visible. The steward
and JEV kill switches remain additional stops for this advisory path.

JEV results, including unavailable answers, are cached by the exact source,
turn and evidence revision in bounded caches. Unchanged state does not repeatedly
invoke inference. No extra scheduler or per-session inference timer is introduced.

## Applying and reversing an archive

After reading evidence and saving the steward result card, main re-observes the
session and its latest turn. The renderer checks the exact clock evidence again
synchronously after audit preparation and immediately before filing. Changed
account, settings, identity, bell, work state or clock refuses the archive.
Older windows omit the new clock fields and cannot qualify; older steward
requests lack clock evidence and are refused by the new renderer.

Both paths use recorded organization changes and durable automatic archive
receipts, with reason/evidence in History and the steward result card. A failed
durable write leaves the session visible. Duplicate/in-flight execution cannot
archive an already archived row twice. Receipt limits stop new automatic filing
instead of pruning history.

A result card remains stable for its finished turn while another session consumes
it. The archive's fresh clock and semantic review evidence are recorded in History;
rechecking does not rebuild an existing card or change its delivery timestamp.

Automatic archive keeps transcripts, tabs, processes, worktree and folder
membership. It does not delete history, close active work or apply retention
deadlines. Undo/Unarchive remains available and explicitly keeps a restored row
visible. New work on an automatically archived row restores it; a later
independent completion can qualify again. Account sync carries ordinary
organization state; clocks and policy remain scoped to each account on a device.

Validation used bounded fleet diagnostics and required GitHub checks; no local or
fleet test suite was run. Production accuracy and saved human time are unmeasured.
