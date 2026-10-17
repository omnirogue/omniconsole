import { normalizeGitRemoteUrl } from '../../shared/git-remote-identity'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import type { Repo } from '../../shared/repo-types'
import { gitExecFileAsync } from '../git/runner'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import type { ConsoleLocalJob } from './console-local-execution-contract'
import { consoleJobRepositoryIdentity } from './console-job-repository-identity'
import {
  assertConsoleGitSnapshotIsolated,
  consoleCurrentGitSource
} from './console-current-git-source'

export type ConsoleJobWorktree = {
  id: string
  path: string
  branch: string | null
  startSha: string | null
}

type LoopProducer = { candidate_sha: string }

function loopProducer(job: ConsoleLocalJob): LoopProducer | null {
  if (consoleCurrentGitSource(job)) {
    return null
  }
  if (job.action !== 'review' && job.action !== 'repair') {
    return null
  }
  const workflowInputs = job.inputs.find(
    (value): value is Record<string, unknown> =>
      !!value && typeof value === 'object' && !Array.isArray(value) && 'loop_stage' in value
  )
  if (!workflowInputs) {
    return null
  }
  const producer = workflowInputs?.producer
  const candidateSha =
    producer && typeof producer === 'object' && !Array.isArray(producer)
      ? (producer as Record<string, unknown>).candidate_sha
      : null
  if (typeof candidateSha !== 'string' || !/^[a-f0-9]{40}$/.test(candidateSha)) {
    throw new Error('The loop successor has no immutable producer candidate.')
  }
  return { candidate_sha: candidateSha }
}

// Why: a folder workspace is not a repository; its Git jobs run in the attached repo that is the
// job's frozen repository, so resolve that before the host and kind checks below.
async function resolveSelectedJobRepo(
  runtime: OrcaRuntimeService,
  workspace: { id: string; repoId: string },
  jobRepo: string
): Promise<Repo> {
  const scope = parseWorkspaceKey(workspace.id)
  if (scope?.type !== 'folder') {
    return runtime.showRepo(workspace.repoId)
  }
  const expected = consoleJobRepositoryIdentity(jobRepo)
  const attached = expected
    ? runtime.resolveFolderWorkspaceJobRepo(scope.folderWorkspaceId, expected)
    : null
  if (!attached) {
    throw new Error(
      `Attach ${jobRepo} to this folder workspace to run Git jobs here; nothing was created.`
    )
  }
  return attached
}

export async function resolveConsoleJobRepository(
  runtime: OrcaRuntimeService,
  selector: string,
  job: ConsoleLocalJob
): Promise<Repo> {
  if (job.workspace || !job.repo || !job.baseBranch) {
    throw new Error('The admitted Git job requires a repository and base branch.')
  }
  const workspace = await runtime.showManagedTerminalWorkspace(selector)
  if (workspace.hostId && workspace.hostId !== 'local') {
    throw new Error(
      'Local execution requires a repository on this Mac; the selected host is unverifiable here.'
    )
  }
  const repo = await resolveSelectedJobRepo(runtime, workspace, job.repo)
  if (repo.connectionId || (repo.executionHostId && repo.executionHostId !== 'local')) {
    throw new Error(
      'The repository executes on another host. Select local placement on that host or fleet placement.'
    )
  }
  if (repo.kind === 'folder') {
    throw new Error(
      'This folder workspace has no Git repository. Select the job repository to create its branch.'
    )
  }
  if (process.platform === 'win32' && parseWslUncPath(repo.path)) {
    throw new Error(
      'Local workflow acceptance in a WSL workspace requires an execution-host process adapter.'
    )
  }
  const remote = (
    await gitExecFileAsync(['remote', 'get-url', 'origin'], { cwd: repo.path })
  ).stdout.trim()
  const expected = consoleJobRepositoryIdentity(job.repo)
  const actual = normalizeGitRemoteUrl(remote)
  if (!expected || !actual || actual.toLowerCase() !== expected) {
    throw new Error(
      'The selected repository does not match the repository frozen in the admitted job.'
    )
  }
  return repo
}

export async function prepareConsoleJobWorktree(
  runtime: OrcaRuntimeService,
  repo: Repo,
  job: ConsoleLocalJob
): Promise<ConsoleJobWorktree> {
  if (job.workspace || !job.repo || !job.baseBranch) {
    throw new Error('The admitted Git job requires a repository and base branch.')
  }
  const branch = job.revision?.branch ?? `omni/${job.id}`
  if (job.revision && !job.revision.confirmed) {
    throw new Error('The revision plan has not been confirmed.')
  }
  await gitExecFileAsync(['check-ref-format', '--branch', branch], { cwd: repo.path })
  const producer = loopProducer(job)
  const baseRef = producer?.candidate_sha ?? job.baseSha ?? job.baseBranch
  const frozenSha = (
    await gitExecFileAsync(['rev-parse', '--verify', `${baseRef}^{commit}`], { cwd: repo.path })
  ).stdout.trim()
  if ((producer || job.baseSha) && frozenSha !== baseRef) {
    throw new Error('The frozen base commit is unavailable.')
  }
  const listed = await runtime.listManagedWorktrees(repo.id, 10_000)
  if (listed.truncated) {
    throw new Error('The repository worktree list is incomplete; no branch was created.')
  }
  const existing = listed.worktrees.find(
    (worktree) => worktree.git.branch === branch || worktree.git.branch === `refs/heads/${branch}`
  )
  if (job.revision && !existing) {
    throw new Error('The confirmed revision branch must be opened as an existing worktree first.')
  }
  const worktree =
    existing ??
    (
      await runtime.createManagedWorktree({
        repoSelector: repo.id,
        name: job.id,
        branchNameOverride: branch,
        baseBranch: baseRef,
        compareBaseRef: job.baseBranch,
        runHooks: false,
        setupDecision: 'skip',
        activate: true,
        lineage: { noParent: true }
      })
    ).worktree
  const resolved = await runtime.showManagedTerminalWorkspace(`id:${worktree.id}`)
  const cwd = resolved.git.path
  assertConsoleGitSnapshotIsolated(job, cwd)
  const head = (await gitExecFileAsync(['rev-parse', '--verify', 'HEAD'], { cwd })).stdout.trim()
  if (producer && job.action === 'repair' && job.revision && head !== frozenSha) {
    try {
      await gitExecFileAsync(['merge-base', '--is-ancestor', frozenSha, head], { cwd })
    } catch {
      throw new Error(
        'The confirmed repair worktree does not descend from its immutable producer candidate.'
      )
    }
  } else if ((!job.revision || producer) && head !== frozenSha) {
    throw new Error(
      producer
        ? 'The loop successor worktree is not at its immutable producer candidate.'
        : 'The job worktree is not at its frozen base commit.'
    )
  }
  const dirty = await gitExecFileAsync(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { cwd }
  )
  if (dirty.stdout) {
    throw new Error(
      'The job worktree has existing changes; resolve them before starting this attempt.'
    )
  }
  return { id: resolved.id, path: cwd, branch, startSha: head }
}
