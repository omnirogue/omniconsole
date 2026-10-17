/**
 * The real dependencies behind a `--host` move. Reads: this computer's git for the sources, the
 * registered repositories and workspaces for the target. The one write is the existing agent launch
 * (`session-transfer-host-launch.ts`). No provisioning, renting, connecting or VM recipe is used.
 */

import {
  getRepoExecutionHostId,
  getWorktreeExecutionHostId,
  parseExecutionHostId
} from '../../shared/execution-host'
import {
  getProjectIdentityKey,
  isHostLocalProjectId
} from '../../shared/project-host-setup-projection'
import type { Repo } from '../../shared/repo-types'
import type { Worktree } from '../../shared/worktree/types'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { getRegisteredSshState, listRegisteredSshTargets } from '../ssh/ssh-target-registry'
import { SessionManageRefusal } from './session-manage-refusal'
import { readSidebarRows } from './session-manage-runtime-actions'
import type { TransferSession } from './session-manage-transfer-contract'
import type { SessionTransferHostDeps, TransferSourceWork } from './session-transfer-host-contract'
import { refuseSourcesOffBranch } from './session-transfer-host'
import { launchOnSshHost, type HostLaunchInput } from './session-transfer-host-launch'
import {
  resolveHostMoveWorkspace,
  shortBranchName,
  type HostMoveRepo,
  type HostMoveWorktree
} from './session-transfer-host-workspace'

function targetId(hostId: string): string | null {
  const host = parseExecutionHostId(hostId)
  return host?.kind === 'ssh' ? host.targetId : null
}

export function sshHostLabel(hostId: string): string | null {
  const id = targetId(hostId)
  const target = id ? listRegisteredSshTargets().find((candidate) => candidate.id === id) : null
  return target ? target.label || target.id : null
}

export function sshHostReachable(hostId: string): boolean {
  const id = targetId(hostId)
  return id !== null && getRegisteredSshState(id)?.status === 'connected'
}

export async function readTransferSourceWork(
  runtime: Pick<OrcaRuntimeService, 'getRuntimeGitStatus' | 'getRuntimeGitUpstreamStatus'>,
  source: TransferSession
): Promise<TransferSourceWork> {
  const path = source.row.worktreePath ?? source.entry.worktreePath
  if (source.row.workspaceKind === 'folder') {
    return { kind: 'folder', path }
  }
  if (source.row.workspaceKind !== 'git') {
    throw new SessionManageRefusal(
      `This computer cannot tell whether “${source.entry.title}” works in a git workspace, so its work cannot move. Nothing was changed.`
    )
  }
  const selector = `id:${source.entry.worktreeId}`
  const status = await runtime.getRuntimeGitStatus(selector, {
    admissionTier: 'interactive',
    includeLineStats: false
  })
  // The status projection counts a gone upstream as 0 ahead; the effective reader runs rev-list.
  const upstream = status.upstreamStatus
    ? await runtime.getRuntimeGitUpstreamStatus(selector).catch(() => null)
    : null
  return {
    kind: 'git',
    path,
    branch: shortBranchName(status.branch),
    head: status.head ?? null,
    upstream:
      !upstream || upstream.upstreamStatusUnknown
        ? 'unknown'
        : upstream.hasUpstream && upstream.upstreamName
          ? { name: upstream.upstreamName, ahead: upstream.ahead }
          : 'none',
    uncommitted: status.didHitLimit
      ? (status.statusLength ?? status.entries.length)
      : status.entries.length
  }
}

function hostMoveRepo(repo: Repo): HostMoveRepo {
  const identity = getProjectIdentityKey(repo)
  return {
    id: repo.id,
    label: repo.displayName,
    hostId: getRepoExecutionHostId(repo),
    identity: isHostLocalProjectId(identity) ? null : identity
  }
}

function hostMoveWorktree(worktree: Worktree, repos: ReadonlyMap<string, Repo>): HostMoveWorktree {
  return {
    id: worktree.id,
    repoId: worktree.repoId,
    path: worktree.path,
    branch: shortBranchName(worktree.branch),
    hostId: getWorktreeExecutionHostId(worktree, repos.get(worktree.repoId)),
    name: worktree.displayName
  }
}

export function runtimeTransferHostDeps(input: HostLaunchInput): SessionTransferHostDeps {
  const { runtime } = input.context
  return {
    reachable: sshHostReachable,
    label: sshHostLabel,
    readWork: (source) => readTransferSourceWork(runtime, source),
    async plan(sources, request) {
      const label = sshHostLabel(request.hostId)
      if (label === null) {
        throw new SessionManageRefusal(
          `No SSH host ${request.hostId} is set up on this computer; read omni host list. Nothing was changed.`
        )
      }
      if (!sshHostReachable(request.hostId)) {
        throw new SessionManageRefusal(
          `${label} (${request.hostId}) is not connected, so this computer cannot verify anything there (unverifiable). Nothing was asked, started or archived. Connect it in OmniConsole, then retry.`
        )
      }
      const works: TransferSourceWork[] = []
      for (const source of sources) {
        works.push(await readTransferSourceWork(runtime, source))
      }
      refuseSourcesOffBranch(sources, works)
      const repos = runtime.listRepos()
      const byId = new Map(repos.map((repo) => [repo.id, repo]))
      const sourceRepos = sources.map((source, index) => {
        const repo = source.row.repoId ? byId.get(source.row.repoId) : undefined
        if (works[index].kind === 'git' && !repo) {
          throw new SessionManageRefusal(
            `This computer cannot find the repository of “${source.entry.title}”. Nothing was changed.`
          )
        }
        return works[index].kind === 'git' && repo ? hostMoveRepo(repo) : null
      })
      const listed = await runtime.listManagedWorktrees(undefined, 10_000)
      const named =
        request.workspace === undefined
          ? undefined
          : {
              selector: request.workspace,
              worktree: await runtime
                .showManagedTerminalWorkspace(request.workspace)
                .then((worktree) => hostMoveWorktree(worktree, byId))
                .catch(() => null)
            }
      const first = works[0]
      const workspace = resolveHostMoveWorkspace({
        hostId: request.hostId,
        label,
        sourceRepos,
        sourceTitles: sources.map((source) => source.entry.title),
        branch: first.kind === 'git' ? first.branch : null,
        upstream:
          first.kind === 'git' && typeof first.upstream === 'object' ? first.upstream.name : null,
        repos: repos.map(hostMoveRepo),
        worktrees: listed.worktrees.map((worktree) => hostMoveWorktree(worktree, byId)),
        ...(named ? { named } : {}),
        sessions: (await readSidebarRows(runtime)).map((row) => ({
          worktreeId: row.worktreeId,
          title: row.title,
          archived: row.archived
        }))
      })
      return { hostId: request.hostId as `ssh:${string}`, label, workspace, works }
    },
    launch: (plan, source, title, prompt) => launchOnSshHost(input, plan, source, title, prompt)
  }
}
