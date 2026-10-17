/**
 * Which existing workspace on the other computer a moved session continues in. Only an existing,
 * unoccupied workspace of the same repository qualifies; otherwise the refusal names the exact
 * command that would create one. Nothing here creates, clones or provisions anything.
 */

import { SessionManageRefusal } from './session-manage-refusal'
import type { HostMoveWorkspace } from './session-transfer-host-contract'

export type HostMoveRepo = {
  id: string
  label: string
  hostId: string
  /** The cross-host repository identity; null when the repo has no remote to match on. */
  identity: string | null
}

export type HostMoveWorktree = {
  id: string
  repoId: string
  path: string
  branch: string | null
  hostId: string
  name: string
}

export type HostMoveWorkspaceInput = {
  hostId: string
  label: string
  /** Each source's repo on this computer, aligned with the sources; null for a folder workspace. */
  sourceRepos: (HostMoveRepo | null)[]
  sourceTitles: string[]
  /** The first source's branch and its upstream (`origin/<branch>`). */
  branch: string | null
  upstream: string | null
  repos: HostMoveRepo[]
  worktrees: HostMoveWorktree[]
  /** `--workspace`, resolved: absent when not given, null when it matched nothing. */
  named?: { selector: string; worktree: HostMoveWorktree | null }
  sessions: { worktreeId: string; title: string; archived: boolean }[]
}

export function shortBranchName(ref: string | null | undefined): string | null {
  const name = ref?.trim().replace(/^refs\/heads\//, '')
  return name ? name : null
}

function refuse(message: string): never {
  throw new SessionManageRefusal(`${message} Nothing was changed.`)
}

function sameRepository(input: HostMoveWorkspaceInput): HostMoveRepo | null {
  const first = input.sourceRepos[0] ?? null
  input.sourceRepos.slice(1).forEach((repo, index) => {
    const same = first
      ? repo !== null && (first.identity ? first.identity === repo.identity : first.id === repo.id)
      : repo === null
    if (!same) {
      refuse(
        `“${input.sourceTitles[index + 1]}” is not in the same repository as “${input.sourceTitles[0]}”; move them separately.`
      )
    }
  })
  return first
}

export function resolveHostMoveWorkspace(input: HostMoveWorkspaceInput): HostMoveWorkspace {
  const where = `${input.label} (${input.hostId})`
  const repo = sameRepository(input)
  const take = (worktree: HostMoveWorktree): HostMoveWorkspace => {
    const open = input.sessions.filter(
      (session) => session.worktreeId === worktree.id && !session.archived
    )
    if (open.length > 0) {
      // Why: two agents in one checkout edit the same files and fight over its branch.
      refuse(
        `${worktree.path} on ${where} already has ${open.length === 1 ? 'an open session' : `${open.length} open sessions`} (${open.map((session) => `“${session.title}”`).join(', ')}). Name another workspace with --workspace, or finish those first.`
      )
    }
    return {
      id: worktree.id,
      path: worktree.path,
      branch: shortBranchName(worktree.branch),
      name: worktree.name
    }
  }
  if (input.named) {
    const { selector, worktree } = input.named
    if (!worktree) {
      refuse(
        `No workspace matches --workspace ${selector}. Read the ids with omni worktree list --json.`
      )
    }
    if (worktree.hostId !== input.hostId) {
      refuse(`--workspace ${selector} is on ${worktree.hostId}, not on ${where}.`)
    }
    const holds = input.repos.find((candidate) => candidate.id === worktree.repoId)
    if (repo && (!holds?.identity || holds.identity !== repo.identity)) {
      refuse(
        `--workspace ${selector} holds ${holds ? holds.label : 'a folder'}, not ${repo.label}.`
      )
    }
    return take(worktree)
  }
  if (!repo) {
    refuse(
      `“${input.sourceTitles[0]}” works in a folder workspace, which has no branch another computer can fetch. Name the workspace on ${where} that already holds its files with --workspace <selector>.`
    )
  }
  const branch = input.branch
  if (!repo.identity || !branch) {
    refuse(
      `${repo.label} has ${repo.identity ? 'no branch checked out' : 'no git remote'} here, so ${where} cannot fetch this work. Name a workspace there with --workspace <selector>.`
    )
  }
  const copies = input.repos.filter(
    (candidate) => candidate.hostId === input.hostId && candidate.identity === repo.identity
  )
  if (copies.length === 0) {
    refuse(
      `${where} has no copy of ${repo.label} set up, so there is no workspace to continue in. SSH hosts are set up in the OmniConsole app (add ${input.label} to the project by cloning it or importing an existing folder); then retry, or name a workspace there with --workspace <selector>.`
    )
  }
  const onBranch = input.worktrees.filter(
    (worktree) =>
      worktree.hostId === input.hostId &&
      copies.some((copy) => copy.id === worktree.repoId) &&
      shortBranchName(worktree.branch) === branch
  )
  if (onBranch.length > 1) {
    refuse(
      `${onBranch.length} workspaces on ${where} have branch ${branch} checked out (${onBranch.map((worktree) => `id:${worktree.id}`).join(', ')}). Name one with --workspace.`
    )
  }
  if (onBranch.length === 1) {
    return take(onBranch[0])
  }
  const name = branch
    .split('/')
    .pop()!
    .replace(/[^\w.-]+/g, '-')
  const commands = copies.map(
    (copy) =>
      `omni worktree create --repo id:${copy.id} --name ${name} --base-branch ${input.upstream ?? `origin/${branch}`} --no-parent --json`
  )
  return refuse(
    `No workspace on ${where} has branch ${branch} checked out. Create one with ${commands.join(' or ')}, then retry with --workspace id:<its worktree id>; or name an existing workspace there with --workspace.`
  )
}
