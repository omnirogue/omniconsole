# Review decisions back to the publishing conversation

Desktop CLI publishers have no MCP connection on which the server can append an
artifact notice. The desktop's existing handoff review timer also reads decisions
for its own locally published review pages and queues a notification to their
publishing conversation. No additional service, transport or approval store is
introduced.

At publication, the private share record pins the signed-in account, ledger row,
provider conversation, pane, workspace and returned artifact revision. Create
recovery retains that original binding even when another conversation retries the
same publication after a lost response. A decision
is eligible only while those identities still agree and the server confirms the
current revision and ownership. Missing bindings and older share records are not
guessed or reassigned. Account switches, replaced conversations, archived panes
and unreachable hosts leave the saved decision available to read with
`omni artifacts status`.

Delivery uses the existing prompt queue and its process/host guards. The review
receipt is persisted before enqueue; its stable entry id prevents a repeated poll
from enqueueing another copy. Queued entries regain their current process binding
after restart. Only a proven unsent failure can be retried. Uncertain writes are
retained, and removing old queue history does not replay an accepted notification.
The notification asks the recipient to read the current saved decision before
acting; it neither grants extra authority nor executes the approved action.

The normal review timer runs every minute. A busy conversation consumes its queued
notification when it becomes available. Queue acceptance and model consumption are
separate: the server's existing MCP notice status describes that MCP channel only,
not the desktop's prompt queue or action completion.

## Sleeping until the decision (OAOS-12)

A review page published from an OmniConsole agent pane (`omni artifacts share|update --review`)
records a `sleep` block beside the share record's `sourceReview`: the provider, the account home
that holds the transcript, the model and effort read from the agent's command line, the workspace,
and the revision. `--keep-session` records none, and the session keeps today's live delivery. The
CLI prints one line saying which applies on this computer.

The session stays live in Waiting for `reviewWaitLiveMinutes` (Settings → Artifacts, default 60)
after its turn ends. The existing hibernation timer then sleeps it with its own guards, with three
differences for a pane waiting on its review: the review wait replaces the idle window, the reply's
own question does not hold it (the page is the question), and the started-today hold is lifted (the
publish is the explicit contract). Every other keep still applies: on screen, touched in the last
10 minutes, a prompt or permission waiting, queued work, Keep going, pinned, saved, routine,
protected paths and panes, and an unset protection policy. Idle auto-close must be On with the
restore flood guard; Shadow only logs. When this computer would not sleep it (idle auto-close not
On, protections never set, or the pane protected at publish), no wait is recorded at all, so the
session keeps running and is never slept, woken or deleted for that page; the CLI says why. The
sleep record gains the model and effort flags.

The 60-second review pass delivers an approval or a changes request to the session's own pane
whenever it is live, as before. Only a wait the hibernation timer put to sleep (`asleep`, recorded
by the timer when it slept the pane) is resumed: `resumeConversation` restarts the parked row from
its record, or resumes from the transcript under its own account with the recorded model and
effort. After an app restart a parked pane has no terminal record and observes as unverifiable;
then the window restarts it only when its checkpoint is hibernation's own (the automatic-sleep
shape, never a quit or live checkpoint), the tab holds no PTY, and the daemon positively answers
that the PTY its layout still names is gone (a working agent kept by the daemon in an unmounted
tab is never restarted). A live pane holding the conversation always gets the decision; an
unverifiable one only ever blocks a resume. With no window open the wake waits for one: only the window can
restart a parked row, and a tab started without one is invisible to the owner's remembered rows.
A limited account holds the wake until its reset; accounts are never switched. A resume refused
before anything started reads `stalled` and is retried after 5 minutes; one that started a
terminal it could not confirm is never retried automatically. A pane that left the ledger while
asleep is still woken: the wake checks the conversation id itself. The binding moves to the woken
pane, the decision is queued once through the existing receipt, and the wait reads `awake`. A
session that waits but was not put to sleep for the review (ended by hand, or on a computer that
never sleeps it) is not resumed; the decision reaches it when it runs again.

The message names the decision, the revision, who decided and when (ET), the comment and the edits
(cut at 2,000 characters), and what to do: carry out exactly that revision, apply the edits (or
republish when an edit touches money, a customer send, an ad budget or access), or revise and
publish a new revision of the same page. A Reject never wakes a sleeping session; a live one is
told to stop.

## Responses in: reviews and studies

A review or study page (`review.type` `review` or `study`) collects each person's answer instead of
a decision: its status stays `pending` and nobody approves it. The same review pass reads the
server's `progress`. Once it is ready on the revision the session waits on (everyone named answered,
or the due time passed when anyone may answer), the viewer owns the page and may read its answers
(`blind` is not true: an owner who named themselves on a study is told once they have answered), the
page is open and no decision exists on that revision, the pass wakes a slept session exactly as for
a decision (there is no Reject path) and queues one "Responses in" notice through the same receipt,
keyed `ready:<slug>:<revision>`, so each revision is told once. The notice says it is not an
approval and how to read the answers (`omni artifacts status <slug> --json`, `responses`). Where the
summary of their common themes and disagreements goes depends on the type: a review's goes in one
comment on the page (OmniConsole `artifact_comment`, or the reply to the owner without that tool); a
study's goes in the reply to the owner and never on the page while it is open, because the owner's
comments on an open study reach people who haven't answered. When the due time passed with no
answer, the notice says there is nothing to sum up and leaves the next step to the owner. The
session closes the ask (`omni artifacts close <slug> --done --revision <n>`, the conclusion as the
note) only if it was told to act on the answers and the ask is still open; otherwise the decision
and the close are the owner's. The wait then reads `awake`; the owner's later close (done, or no
action) ends it through the closed-without-decision path. An older server sends no `progress`, and
nothing changes. As for a decision, the server also appends its own `responses_in` notice to the
publishing session's next OmniConsole MCP tool result, with the same rule for the summary; the two
channels stay separate. A wake copy for another computer needs a decision, so answers coming in
never wake the session elsewhere: with its own computer off, it is told when that computer checks in
again.

`omni artifacts status` prints the same steps to the owner. Anyone else is told that the owner reads
the answers and closes the ask, and a study's viewer who hasn't answered is told the answers show
once they submit their own. The desktop's bulk Mark done, No action and Superseded by skip studies:
a study that anyone answered cannot be reopened, so it is closed on its own.

## Reject deletes the session (OAOS-12)

A Reject on the revision a session waits on deletes that session for good, on the computer that
holds it, as soon as the review pass sees it, reading the window's own rows (never the owner's
remembered listing; with no window it waits). Every pane holding the conversation, folded ones
included, must be idle, exited, or parked (a slept pane whose checkpoint the window holds and for
which the runtime has no terminal). A busy one is told to stop and deleted once idle; an
unverifiable one is never deleted on a guess. Then the delete is marked sent, and begun once a tab
closes: a later pass finishes a begun delete after a crash without checking again, while a sent one
whose first tab the window refused (it turned busy) or did not answer for is checked from the start
again, and finished only if a restored window no longer lists it and has it on its deleted list. Its rows and tabs are deleted through the recorded organization
change (`executor: app/artifact-review`, prepared → applied) without a Recently closed entry and
without Undo, so resume refuses the conversation; its queued prompts, Needs You decisions and
outcome chains are cleared (a committed outcome stays and is named); every copy of its transcript
is removed (Claude's JSONL, the transcript recorded at publish, `<id>/` and `session-env/<id>/`;
every hard link of a Codex rollout, archived ones too, and its `session_index.jsonl` line by id);
and, only when `omni session launch` created that git worktree for this pane, it is the workspace
recorded at publish, no other session uses it, and it is on the branch created with it (worktree
metadata `createdBranch`: no local or remote branch had that name; a worktree on any other branch,
or made before this was recorded, is kept whole), the worktree and then its local branch. The
remote branch goes only when it is origin's branch
of the same name (never the default branch or a base it tracks), this computer created it by a push
(its remote-tracking reflog starts with one; a shared base checked out by name was fetched), its
head equals the local head, and GitHub answers that no pull request is open from it (in origin, or
in upstream or origin's fork parent and root) or into it;
on another forge, or when GitHub cannot answer, it stays and the record says why. Folder workspaces
are never deleted. Callers cannot ask for this delete: `sessionFolders.mutate` refuses `purge`.
Nothing is deleted while the window lists no pane for the conversation, and a window still
restoring its sessions refuses to list them (`listSessions` with `requireReady`).

Nothing is deleted while it still waits on or acts on another page (pending or approved, asked of
the page itself when no wait was recorded), while any of its panes is protected (protections never
set count as protected, unlike the finite-worker baseline), or with no window open. One `session-actions.jsonl` line (`actor: artifact-review`, the page, revision, decision id
and who) lists what was removed and kept; the page, its revisions and the decision stay on OmniOS.
A later decision on a deleted session's page changes nothing. A page closed with no decision
(withdrawn, no action or replaced) archives a sleeping, unprotected session instead, which can be
undone, and ends its wait.

## Waiting for a decision: Work tab and OmniOS (OAOS-12)

Each review pass sends this computer's heartbeat (`POST /v1/artifacts/source-heartbeat`, `{hostId,
host}` with the Mac's sharing name, or the host name without its domain) before it delivers and
again after its reports, but only while a window is open and a wait is open (waiting, asleep,
waking or stalled, of any age): a quit computer cannot wake a sleeping session. States are reported
for waits from the last 7 days. It reports each wait's state once per change (`POST /v1/artifacts/{slug}/source-state`: state, revision, host, when, and a reason from a
fixed vocabulary only, never an account, path or error text). A server without these endpoints
answers 404 without a code or 405, and the desktop leaves it alone for 30 minutes; a coded refusal
(a deleted page, a revision the page never had) is not sent again until the state changes; a clock
more than five minutes fast (`invalid_at`) is retried. OmniOS shows the
state as a chip in Work → Decisions and labels Reject "Reject and delete session" while the session
is waiting or asleep on the current revision.

The desktop Work tab lists the same pages under Needs You — Decisions ("Waiting for a decision"):
the OmniOS inbox for the signed-in person (`GET /v1/artifact-reviews/inbox`) joined with this
computer's own waits, this computer's state winning for its own pages, plus its waits whose page
is not in the inbox. This computer's state counts only for the revision now waiting. Each row has
the title, question, who asked, age, a state chip (OmniOS's fixed reason words; the full local
reason on hover), "Its computer is not checking in" for another computer's session as OmniOS shows
it, Open page and, for a session on this computer, Open session. A row leaves when its wait is awake
or deleted; a page older than 7 days is marked old. When OmniOS cannot be reached, or this computer
is signed out, only this computer's pages are listed and the section says why; with nothing to list
it is hidden.

## Waking on another computer: the owner's side (OAOS-12 Phase 2)

When a wait reads `asleep`, it has not run here again since it slept, and nothing runs the
conversation (no live pane; an unverifiable one counts only when the window confirms it parked by
sleep, or with no window, when the runtime holds no terminal for it two minutes after it started
and no agent report came from the pane later than a minute after it slept), the review pass builds one **wake copy**
for that revision and uploads it to OmniOS (`POST /v1/artifacts/{slug}/wake-copy`, parts of 8 MiB, then `complete`; CONTRACT.md).
The copy is relocate's export of the conversation (`exportRelocationBundle`: the Claude JSONL and
its folder, or the Codex rollout; checksummed; never credential-shaped files), and for a folder
workspace up to 20 MB of the files the session wrote there (newest first, regular files inside
the folder only, documents, code and images only, never a secret by name or a file holding a key or
token shape; exactly the bytes checked are packed), in one length-prefixed container, gzipped, at most 64 MiB. The heartbeat
goes between parts, and the `ls-remote` check gives up after 30 seconds, so a slow network never
holds the review pass. Only a workspace
another computer can have moves:

| Workspace | Wake copy |
| --- | --- |
| A folder inside `~/Work` | yes; the copy carries its path relative to `~/Work` |
| A git worktree, clean, whose branch head is exactly origin's (`ls-remote`) | yes; remote URL (no user info), branch, commit |
| Anything else | no: `outside Work`, `uncommitted changes`, `unpushed changes`, `too large`, `could not verify` |

The wait keeps `wakeCopy` (`{revision, at, sha256}`, `{revision, at, refused}`, or `pending` from
the first byte until OmniOS confirms, since a lost reply may hide a ready copy); a refusal is tried
again after 30 minutes (the branch may have been pushed meanwhile), except `too large` and
`outside Work`, which cannot change while the session sleeps.

A copy never outlives the reason for it. The computer withdraws it (`DELETE`, repeated every pass
until OmniOS confirms) when the wait reads `awake` or `waiting`; when a person opened the session
again, which also marks the wait `reopened` (it stays `asleep`, so a decision still wakes it here
once it is closed, but it is never copied again for this revision); and right before
it wakes the session itself, which OmniOS refuses while another computer's claim is active, so
exactly one computer runs it. An OmniOS without the
routes records `not available yet` and is left alone for 30 minutes. State reports carry
`portable` (true with a copy, false with the refusal word as the reason), so the page reads "Can
wake anywhere" or "Only on <host> (<reason>)".

Before it wakes a sleeping session for a decision, and on every pass while a wait is asleep or
stalled with a copy possibly up (a returning computer learns of a move even after the page moved
on), this computer reads `GET wake-claim?revision=<its revision>`:

- no claim, or its own: it wakes as in Phase 1, then deletes its copy;
- claimed by another computer and not done: it holds ("it is waking on <host>");
- done elsewhere: it records the conversation as relinquished to that computer in the session
  host registry (`yieldSessionHostConversationToClaim`, relocate's rule: resume, restart and
  adoption refuse it from then on), asks the window to drop the pane's parked checkpoint
  (`forgetSleptPane`, so revealing the tab starts nothing), archives the row through the recorded
  organization path ("Moved to <host>; its history stays here") and sets the wait to `moved` with
  that host (not reported to OmniOS, which already shows the claim's host). Its transcript stays as
  history. If a person opened it here again meanwhile, nothing is stopped or given up: the wait
  reads stalled, "Moved to <host>, but it was opened here again". A failed archive is retried.
- OmniOS cannot be asked: with a copy possibly up it holds; without one no other computer can
  have it. OmniOS lacks the route: it holds only for a copy it saw confirmed (a rollback).
- Nothing is given up while any pane here runs the conversation or that cannot be told; once the
  registry has given it up and its checkpoint is gone, a pane that is not live no longer counts.
- A withdrawal counts only when OmniOS confirms it or answers that the page is gone.

Known gap: when the move is learned with no window open, the registry gives the session up at once,
but the window drops the pane's checkpoint only on its first pass after it opens; a person who opens
that tab within that minute starts it here too, and the wait then reads "opened here again".

A Reject that reaches a moved session's old computer deletes nothing there.

## Waking on another computer: the claiming side (OAOS-12 Phase 2)

Every desktop with a window runs `runWakeClaims` after its review pass: it reads OmniOS's wake
candidates for the signed-in person (pages whose decided session sleeps on a computer that has not
checked in for two minutes; the decider's desktops at once, the publisher's other desktops two
minutes later, so a phone decision reaches the always-on Mac Studio). For each, and at most one move
per pass, it claims the wake only when this computer can run it:

- the provider CLI is here and no older than the one that wrote the transcript (relocate's
  `localProviderVersion`);
- the workspace is here: the `~/Work` folder (its OmniConsole folder workspace, or one created in
  the project that holds it), or this computer's clone of the same repository (matched by remote,
  however it is spelled) with origin's branch still at the commit the session slept on, never a
  branch checked out here already or one with other commits;
- an account is verified with room by the launch chooser (`chooseLocalLaunchHome`: the same
  freshen and choice a launch makes, so an unfocused, background computer refreshes stale readings
  first; the selected default, the system login and the Fable rule apply; chosen again with the
  copy's model after the download, and the move runs on that account), never the sleeping
  computer's account; a workspace whose launches run in WSL here is refused (the pin would drop);
- the relocation switch (`sessionRelocation`, `OMNI_RELOCATION_DISABLED`) is on.

A candidate this computer cannot run is not looked at again for 30 minutes, one it cannot read is
skipped without stopping the others, and every git call here runs in the background tier with a
timeout. A `~/Work` path from another computer must stay inside this computer's `~/Work`.

The claim is first-wins on OmniOS, and its intent is journaled before it is sent. The winner
downloads the copy (only the claim holder may), checks it (`unpackWakeCopy`: checksum, sizes, safe
paths; its header must match the listing), prepares the workspace (a local branch at that
commit, then the runtime's own worktree create on that branch as its base, removed again if it is
not exactly that branch and commit; or the folder workspace, by its registered path), restores written files
only where missing or unchanged, stages the conversation with relocate's `importRelocationBundle`
under the chosen account, and resumes the **same** conversation id with the recorded model and effort,
confirmed only by the agent's own report. It then marks the claim done (the sleeping computer gives
the session up on return) and queues the decision as it stands then (re-read from the page: a decision rejected, a newer
revision, a page closed or superseded meanwhile, or a page that cannot be read sends nothing), bound to the woken agent's process like Phase 1's deliveries, with two
added lines: where it moved from and why, its folder here, and that it runs with this computer's own
accounts. Each step is in `review-wake-claims.json`: a failure known to come before any terminal
(a workspace or account the launch refused) releases the claim with its word (`download failed`, `could not verify`, `could not start`, `cannot run
here`), retried until OmniOS confirms; once a terminal may run it, the claim is never released but
confirmed `done`, so it cannot run twice or stay claimed, including after a crash. The audit log has one line per move.
