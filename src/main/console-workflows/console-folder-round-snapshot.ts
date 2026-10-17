import {
  assertSafeParents,
  preflightConsoleFolderHydration,
  assertConsoleFolderHydrationUnchanged
} from './console-folder-hydration-guard'
import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { z } from 'zod'
import type {
  ConsoleLocalActivation,
  ConsoleLocalJob,
  ConsoleLocalResult
} from './console-local-execution-contract'
import { canonicalDigestJson } from './console-job-digests'
import { readConsoleFolderSelectedFile } from './console-folder-selected-file'
import { consoleCurrentGitSource } from './console-current-git-source'
import { consoleCurrentGitHydrationSources } from './console-current-git-materialization'
import {
  consoleFolderSnapshotPath as relativePath,
  consoleFolderRoundInput as workflowInput,
  consoleFolderRoundSourceFiles as sourceFiles
} from './console-folder-round-selection'
import {
  ConsoleArtifactEvidenceError,
  ConsoleArtifactEvidenceLimitError
} from './console-folder-job-result'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const manifestItem = z
  .object({
    path: relativePath,
    mode: z.number().int().min(0).max(0o777),
    sha256: digest,
    size_bytes: z.number().int().min(0).max(65_536)
  })
  .strict()
export const consoleFolderCandidateSchema = z
  .object({
    schema_version: z.literal(1),
    producer_key: z.string().min(1).max(160),
    job_id: z.string().regex(/^job_[a-z0-9]{8,40}$/),
    task_id: z.string().min(1).max(160),
    attempt: z.number().int().positive(),
    receipt_event_id: z.number().int().positive(),
    fingerprint: digest,
    result_event_id: z.number().int().positive(),
    source_receipt_id: z.string().min(1).max(512),
    verification_report_id: z.string().min(1).max(512),
    candidate_digest: digest,
    evidence_id: z.string().min(1).max(512),
    artifact: z
      .object({
        file_id: z.string().regex(/^tfl_[a-z0-9]{1,64}$/),
        rel: z.string().min(1).max(4096),
        sha256: digest,
        size_bytes: z.number().int().positive().max(65_536)
      })
      .strict(),
    snapshot_digest: digest,
    manifest: z.array(manifestItem).max(288)
  })
  .strict()

export type ConsoleFolderCandidate = z.infer<typeof consoleFolderCandidateSchema>

export function consoleFolderCandidate(job: ConsoleLocalJob): ConsoleFolderCandidate | null {
  const candidate = workflowInput(job)?.folder_candidate
  return candidate ? consoleFolderCandidateSchema.parse(candidate) : null
}

function snapshotDigest(manifest: z.infer<typeof manifestItem>[]): string {
  return createHash('sha256')
    .update(
      canonicalDigestJson(
        manifest.map((item) => ({
          target_path: item.path,
          sha256: item.sha256,
          size_bytes: item.size_bytes
        }))
      )
    )
    .digest('hex')
}

function inside(root: string, path: string): string {
  const absolute = resolve(root, ...relativePath.parse(path).split('/'))
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
    throw new Error('The folder snapshot path escapes its selected workspace.')
  }
  return absolute
}

export async function hydrateConsoleFolderCandidate(args: {
  activation: ConsoleLocalActivation
  workspacePath: string
  candidate: unknown
  contentBase64: string
}): Promise<void> {
  const expected = consoleFolderCandidate(args.activation.job)
  const candidate = consoleFolderCandidateSchema.parse(args.candidate)
  if (!expected || canonicalDigestJson(expected) !== canonicalDigestJson(candidate)) {
    throw new Error('The downloaded folder candidate differs from the activated handoff.')
  }
  const bytes = Buffer.from(args.contentBase64, 'base64')
  if (
    bytes.toString('base64') !== args.contentBase64 ||
    bytes.length !== candidate.artifact.size_bytes ||
    createHash('sha256').update(bytes).digest('hex') !== candidate.artifact.sha256
  ) {
    throw new Error('The downloaded folder candidate bytes differ from the accepted artifact.')
  }
  const envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Record<
    string,
    unknown
  >
  if (
    envelope.schema_version !== 1 ||
    envelope.kind !== 'folder_report' ||
    envelope.job_id !== candidate.job_id ||
    envelope.attempt !== candidate.attempt ||
    !Array.isArray(envelope.files)
  ) {
    throw new Error('The folder candidate envelope differs from its accepted producer.')
  }
  const allowed = sourceFiles(args.activation.job).map((file) => file.target_path)
  const files = envelope.files.map((item) => {
    const parsed = manifestItem.extend({ content_b64: z.string() }).strict().parse(item)
    const content = Buffer.from(parsed.content_b64, 'base64')
    if (
      content.toString('base64') !== parsed.content_b64 ||
      content.length !== parsed.size_bytes ||
      createHash('sha256').update(content).digest('hex') !== parsed.sha256
    ) {
      throw new Error('A folder candidate file differs from its manifest.')
    }
    return { parsed, content }
  })
  const manifest = files.map(({ parsed }) => ({
    path: parsed.path,
    mode: parsed.mode,
    sha256: parsed.sha256,
    size_bytes: parsed.size_bytes
  }))
  if (
    canonicalDigestJson(manifest) !== canonicalDigestJson(candidate.manifest) ||
    snapshotDigest(manifest) !== candidate.snapshot_digest ||
    files.some(({ parsed }) => !allowed.includes(parsed.path))
  ) {
    throw new Error('The folder candidate manifest differs from its accepted receipt.')
  }
  const currentGit = consoleCurrentGitSource(args.activation.job)
  const sources = currentGit
    ? await consoleCurrentGitHydrationSources(args.activation.job, args.workspacePath)
    : sourceFiles(args.activation.job)
  const observed = await preflightConsoleFolderHydration(
    args.workspacePath,
    sources,
    candidate.manifest,
    Boolean(currentGit)
  )
  for (const path of allowed) {
    await assertConsoleFolderHydrationUnchanged(args.workspacePath, path, observed.get(path)!)
    await assertSafeParents(args.workspacePath, path)
    await rm(inside(args.workspacePath, path), { force: true })
  }
  for (const { parsed, content } of files) {
    const path = inside(args.workspacePath, parsed.path)
    await assertSafeParents(args.workspacePath, parsed.path)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, { flag: 'wx', mode: parsed.mode })
  }
}

function reviewedSnapshot(job: ConsoleLocalJob): Record<string, unknown> {
  const candidate = consoleFolderCandidate(job)
  if (candidate) {
    return {
      schema_version: 1,
      kind: 'accepted_folder_snapshot',
      snapshot_digest: candidate.snapshot_digest,
      artifact_sha256: candidate.artifact.sha256,
      source_job_id: candidate.job_id,
      source_attempt: candidate.attempt
    }
  }
  const source = workflowInput(job)?.current_source
  const snapshot =
    source && typeof source === 'object' && !Array.isArray(source)
      ? (source as Record<string, unknown>).snapshot_digest
      : undefined
  return { schema_version: 1, kind: 'current_task_files', snapshot_digest: digest.parse(snapshot) }
}

export async function consoleFolderRoundArtifact(
  job: ConsoleLocalJob,
  attempt: number,
  cwd: string,
  result: ConsoleLocalResult
): Promise<{ contentBase64: string; sha256: string }> {
  if (!job.workspace && !consoleCurrentGitSource(job)) {
    throw new ConsoleArtifactEvidenceError(
      'A Git snapshot needs its explicit frozen current source.'
    )
  }
  if (job.artifactResult?.path === 'folder-review.json') {
    return encoded({
      ...JSON.parse(Buffer.from(JSON.stringify(result)).toString()),
      reviewed_snapshot: reviewedSnapshot(job)
    })
  }
  if (job.artifactResult?.path !== 'folder-snapshot.json') {
    throw new Error('The folder round snapshot contract is unavailable.')
  }
  const baseline = new Map(
    consoleFolderCandidate(job)?.manifest.map((item) => [item.path, item.sha256]) ??
      sourceFiles(job)
        .filter((item) => item.file?.sha256 !== null)
        .map((item) => [item.target_path, digest.parse(item.file?.sha256)])
  )
  const files: {
    path: string
    mode: number
    sha256: string
    size_bytes: number
    content_b64: string
  }[] = []
  const changed: string[] = []
  for (const path of sourceFiles(job).map((file) => file.target_path)) {
    try {
      const { content, mode } = await readConsoleFolderSelectedFile(cwd, path)
      const sha256 = createHash('sha256').update(content).digest('hex')
      files.push({
        path,
        mode,
        sha256,
        size_bytes: content.length,
        content_b64: content.toString('base64')
      })
      if (baseline.get(path) !== sha256) {
        changed.push(path)
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        changed.push(path)
        continue
      }
      // A symlink or directory left at a selected path is the worker's output shape, not a host fault.
      if (code === 'ELOOP' || code === 'EISDIR' || code === 'ENOTDIR') {
        throw new ConsoleArtifactEvidenceError(`Selected output ${path} is not a regular file.`)
      }
      if (code === 'EACCES' || code === 'EPERM') {
        throw new ConsoleArtifactEvidenceError(`Permission denied on the selected path ${path}.`)
      }
      throw error
    }
  }
  if (!result.worker_report?.trim()) {
    throw new ConsoleArtifactEvidenceError('The folder snapshot requires the worker response.')
  }
  return encoded({
    schema_version: 1,
    kind: 'folder_report',
    job_id: job.id,
    attempt,
    response: result.worker_report,
    changed_files: changed.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))),
    files
  })
}

function encoded(value: unknown): { contentBase64: string; sha256: string } {
  const bytes = Buffer.from(canonicalDigestJson(value))
  if (!bytes.length || bytes.length > 65_536) {
    throw new ConsoleArtifactEvidenceLimitError()
  }
  return {
    contentBase64: bytes.toString('base64'),
    sha256: createHash('sha256').update(bytes).digest('hex')
  }
}
