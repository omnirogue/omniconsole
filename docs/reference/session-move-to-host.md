# Moving a session to another computer

`omni session handoff --to new --host ssh:<id>` (and `session consolidate --into new --host …`)
hands a session's work to a **new** session on an SSH host. It is the existing handoff with a
host target, not relocation: the source conversation stays on this computer and is archived
here only after the new session accepts. Moving the same provider conversation is a later
phase; per `docs/remote-agents/IMPLEMENTATION-2026-09-24.md`, a copied prompt alone is not
relocation, so nothing here claims one.

Code: `src/main/session-manage/session-transfer-host*.ts`, wired into `transferSessions`
(`session-manage-transfer.ts`) through optional `host` input and dependencies.

## Steps

1. **Validate (reads only).** Sources must pass the existing transfer checks, so a source that
   runs on an SSH host or a paired OmniConsole is refused by `remoteExecutionRefusal`. The host
   must be a registered, connected SSH target; `runtime:<id>` is refused (this computer cannot
   observe a paired host's turn to verify acceptance). Each source's git state is read on this
   computer through the existing readers: `getRuntimeGitStatus` (uncommitted files, branch,
   HEAD) and `getRuntimeGitUpstreamStatus` (the effective upstream and its ahead count via
   `rev-list`; the status projection counts a gone upstream as zero ahead). No new git command
   is introduced, so the Git 2.25 baseline is unchanged.
2. **Target workspace (reads only).** An existing workspace on that host of the same repository
   (`getProjectIdentityKey`, as session prep matches copies) with the source branch checked
   out, or `--workspace <selector>`. Folder workspaces need `--workspace`. Zero, several, or a
   workspace with open sessions is refused; the refusal names the `omni worktree create --repo
   id:<copy> … --base-branch <upstream>` command, or says the project must be set up on that
   host in the app (the CLI cannot set up SSH hosts). Nothing is created.
3. **Pushed work.** Uncommitted files, commits missing from the upstream, or a branch never
   pushed: the source is asked through `session ask` to commit and push its branch, then git is
   read again; still unpushed is refused with the `git push -u` command. The question names the
   branch after `push`, so a shared branch trips the Keep going hard stop and is refused. The
   controller commits and pushes nothing.
4. **Brief.** Asked through `session ask`, as for any handoff; asking turns the source's Keep
   going off. Git is read once more and must still be pushed.
5. **Launch.** The first prompt is the brief, each source's branch, upstream and commit, where
   the work continues, and the acceptance line; the whole prompt passes the hard stops. The
   operation is journaled before dispatch, the acceptance wait subscribes before the spawn, and
   the launch is the existing `createAgentSession` with `sshAccountSelection: best-verified`
   (host-owned account, the same path as `omni session launch`). An unknown launch outcome is a
   partial failure to inspect, never a retry. The new session is titled "<source> (continued)"
   (best effort) and filed in the source's folder.
6. **Acceptance.** The new session's finished turn for that brief, read from the hook reports
   the SSH relay forwards, must be exactly the acceptance line; it is told to fetch and check
   out the branch at that commit first, and not to accept otherwise. It has 10 minutes.
7. **Archive.** The target must still be the same pane on that host and `live`; its checkpoint
   is the same attached relay terminal incarnation (its process table is on the host). The
   sources are archived through the existing archive request with the reason
   "handed off to <title> on <host>". Audit lines name the target and host on the source's
   side and the source brief on the target's side.

## Unreachable is unverifiable

A host that is not connected is refused before anything is asked, with `host.verdict:
'unverifiable'`. If contact is lost after the launch, nothing is archived, the result keeps
`briefSent: true` and `host.verdict: 'unverifiable'`, and the summary says the new session
may still be running. A move is reported complete only after acceptance and archive.

## Nothing is provisioned

The move reads registered hosts and workspaces and launches through the existing path. It
never connects a host, creates a worktree, clones, runs a VM recipe or rents anything. A unit
test proxies the runtime and fails on any provisioning, recipe or connect access, and on any
import of those modules from the move path. Renting stays the person's decision (see the
`omni-sessions` skill recipe).

## Wire compatibility

`sessionManage.handoff` / `sessionManage.consolidate` take optional `host` and `workspace`;
the result has an optional `host`. An older runtime's strict schema refuses them, and the CLI
reports that as an older OmniConsole instead of a schema error. Older CLIs never send them.

## Not supported yet

- Moving the same conversation (provider session continuation across computers).
- Paired OmniConsole targets (`runtime:<id>`), and sources that run on another computer.
- Agents other than Claude and Codex (the host-owned account selection supports those two).
