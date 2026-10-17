import { createHash } from 'node:crypto'
import { isAbsolute, normalize, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { sessionOutcomeCurrentSource } from '../../shared/session-outcome-current-inputs'
import { canonicalDigestJson } from './console-job-digests'
import { consoleJobRepositoryIdentity } from './console-job-repository-identity'
import type { ConsoleLocalJob } from './console-local-execution-contract'

export function consoleCurrentGitSource(job: ConsoleLocalJob) {
  const input = job.inputs.find(
    (value): value is Record<string, unknown> =>
      !!value && typeof value === 'object' && !Array.isArray(value) && 'current_source' in value
  )
  if (!input?.current_source || job.workspace?.kind === 'folder') {
    return null
  }
  const source = sessionOutcomeCurrentSource.parse(input.current_source)
  const workspace = source.workspace
  const git = source.git
  if (
    !workspace ||
    workspace.kind !== 'git' ||
    !git ||
    workspace.host !== 'local' ||
    !isAbsolute(workspace.path) ||
    normalize(workspace.path) !== workspace.path ||
    workspace.path.includes('\0') ||
    !/^[a-f0-9]{40}$/.test(git.head_sha) ||
    workspace.base_sha !== git.head_sha ||
    job.placement !== 'local' ||
    job.workspace ||
    !job.repo ||
    job.revision ||
    !consoleJobRepositoryIdentity(workspace.repo) ||
    consoleJobRepositoryIdentity(workspace.repo) !== consoleJobRepositoryIdentity(job.repo) ||
    job.baseSha !== git.head_sha ||
    job.baseBranch !== workspace.base_branch ||
    !job.artifactResult ||
    job.acceptanceCommands.length ||
    source.files.some((file) => file.task_id !== source.root_task_id) ||
    !isDeepStrictEqual(input.source_files, source.files) ||
    !isDeepStrictEqual(input.source_deletions ?? [], git.deleted_paths)
  ) {
    throw new Error(
      'Current Git inputs differ from their frozen local repository and selected files.'
    )
  }
  const files = source.files.map((file) => ({
    target_path: file.target_path,
    sha256: file.file.sha256,
    size_bytes: file.file.size_bytes
  }))
  const paths = [...files.map((file) => file.target_path), ...git.deleted_paths]
  const compare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b))
  if (
    !paths.length ||
    new Set(paths).size !== paths.length ||
    new Set(paths.map((path) => path.toLowerCase())).size !== paths.length ||
    !isDeepStrictEqual(
      files.map((file) => file.target_path),
      files.map((file) => file.target_path).sort(compare)
    ) ||
    !isDeepStrictEqual(git.deleted_paths, [...git.deleted_paths].sort(compare)) ||
    paths.some((path) =>
      paths.some(
        (other) => path !== other && path.toLowerCase().startsWith(`${other.toLowerCase()}/`)
      )
    ) ||
    createHash('sha256')
      .update(
        canonicalDigestJson({
          head_sha: git.head_sha,
          files,
          deleted_paths: git.deleted_paths
        })
      )
      .digest('hex') !== source.snapshot_digest
  ) {
    throw new Error(
      'Current Git inputs require their exact captured HEAD, files and deletion digest.'
    )
  }
  const loop = input.loop_stage as Record<string, unknown> | undefined
  const round = loop?.round
  const role = loop?.role
  const requiresCandidate =
    !!loop &&
    ((typeof round === 'number' && round > 1) || (source.mode === 'base' && role !== 'producer'))
  const expectedArtifact = loop
    ? role === 'participant'
      ? 'folder-review.json'
      : 'folder-snapshot.json'
    : 'work-result.json'
  if (
    (loop &&
      (!Number.isInteger(round) ||
        !['producer', 'participant', 'repair'].includes(String(role)) ||
        (role === 'producer' ? round !== 0 : Number(round) < 1 || Number(round) > 5))) ||
    requiresCandidate !== !!input.folder_candidate ||
    input.source_overlay !== !requiresCandidate ||
    (role === 'producer' && source.mode !== 'base') ||
    (!loop && source.mode !== 'base') ||
    job.artifactResult.path !== expectedArtifact ||
    (loop &&
      job.action !==
        (role === 'participant' ? 'review' : role === 'repair' ? 'repair' : 'execute')) ||
    job.readOnly !== (job.action === 'review')
  ) {
    throw new Error(
      'The Git round must use its original capture or exact accepted repair snapshot.'
    )
  }
  return { source, workspace, git, input, paths: paths.sort(compare), requiresCandidate }
}

export function assertConsoleGitSnapshotIsolated(job: ConsoleLocalJob, cwd: string): void {
  const current = consoleCurrentGitSource(job)
  if (current && resolve(cwd) === resolve(current.workspace.path)) {
    throw new Error(
      'A current Git review must use an isolated worktree, preserving the source session.'
    )
  }
}
