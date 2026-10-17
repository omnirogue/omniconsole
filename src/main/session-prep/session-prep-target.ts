import { getRepoMainWorktreeId } from '../../shared/worktree/id'
import type { SessionPrepHost, SessionPrepRepo, SessionPrepWorkspace } from './session-prep-host'
import type { SessionPrepBatchRecord, SessionPrepItemRecord } from './session-prep-records'
import {
  assertSessionPrepExecutionHost,
  assertSessionPrepWorkspaceUnchanged,
  resolveSessionPrepHost,
  sessionPrepHostId,
  SessionPrepHostError
} from './session-prep-execution-host'

const basename = (path: string): string =>
  path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .at(-1) ?? path

export function matchSessionPrepRepoHint(
  repos: SessionPrepRepo[],
  hint: string
): SessionPrepRepo | null {
  const needle = hint.trim().toLowerCase()
  if (!needle) {
    return null
  }
  const matches = repos.filter((repo) => {
    const name = repo.name.trim().toLowerCase()
    const segment = basename(repo.path).trim().toLowerCase()
    return name === needle || segment === needle
  })
  if (matches.length > 0) {
    return matches.length === 1 ? matches[0]! : null
  }
  // Why: people say "OmniRogue" for a repository registered as "omnirogue-omniconsole"; one clear
  // containing match is theirs, several are ambiguous.
  const squashed = needle.replace(/[^a-z0-9]/g, '')
  const containing =
    squashed.length >= 4
      ? repos.filter((repo) =>
          [repo.name, basename(repo.path)].some((label) =>
            label
              .toLowerCase()
              .replace(/[^a-z0-9]/g, '')
              .includes(squashed)
          )
        )
      : []
  return containing.length === 1 ? containing[0]! : null
}

export function sessionPrepItemWorkspace(
  item: SessionPrepItemRecord,
  source: SessionPrepWorkspace,
  repos: SessionPrepRepo[]
): SessionPrepWorkspace {
  const namedHost = item.planned.choices?.host
  const targetHost = namedHost
    ? resolveSessionPrepHost(repos, namedHost)
    : sessionPrepHostId(source)
  const candidates = repos.filter((repo) => sessionPrepHostId(repo) === targetHost)
  const hint = item.planned.repoHint
  const moved = item.targetRepoId
    ? (candidates.find((repo) => repo.id === item.targetRepoId) ?? null)
    : null
  if (item.targetRepoId && !moved) {
    throw new SessionPrepHostError('The prepared workspace is no longer registered on this host.')
  }
  if (!hint && !moved && targetHost === sessionPrepHostId(source)) {
    return source
  }
  const sourceRepo = repos.find((repo) => repo.id === source.repoId)
  const copies = sourceRepo?.repositoryKey
    ? candidates.filter((repo) => repo.repositoryKey === sourceRepo.repositoryKey)
    : []
  const matched =
    moved ??
    (hint ? matchSessionPrepRepoHint(candidates, hint) : copies.length === 1 ? copies[0] : null)
  if (!matched) {
    // Why: a basename or missing mapping cannot prove two folders contain the same work.
    throw new SessionPrepHostError(
      `No unambiguous registered workspace for ${hint ? `“${hint}”` : 'this project'} on ${namedHost ?? targetHost}.`
    )
  }
  if (matched.id === source.repoId) {
    return source
  }
  return {
    path: matched.path,
    repoId: matched.id,
    isFolder: matched.isFolder,
    isRemote: matched.isRemote,
    connectionId: matched.connectionId,
    connectionGeneration: matched.connectionGeneration,
    connectionBinding: matched.connectionBinding,
    hostId: sessionPrepHostId(matched)
  }
}

export function sessionPrepSessionWorktreeId(
  batch: SessionPrepBatchRecord,
  source: SessionPrepWorkspace,
  target: SessionPrepWorkspace
): string {
  if (target.repoId === source.repoId) {
    return batch.source.worktreeId
  }
  return getRepoMainWorktreeId({ id: target.repoId, path: target.path })
}

export async function resolveSessionPrepItemTarget(
  host: SessionPrepHost,
  batch: SessionPrepBatchRecord,
  item: SessionPrepItemRecord
): Promise<{ source: SessionPrepWorkspace; target: SessionPrepWorkspace }> {
  const source = await host.resolveWorktree(batch.source.worktreeId)
  assertSessionPrepExecutionHost(source)
  const target = sessionPrepItemWorkspace(item, source, host.listRepos())
  assertSessionPrepExecutionHost(target)
  assertSessionPrepWorkspaceUnchanged(item.executionTarget, target)
  item.executionTarget = { ...target }
  return { source, target }
}
