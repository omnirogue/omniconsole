import type { ConsoleLocalExecutionRecord } from './console-local-execution-state'
import type {
  ConsoleLocalResult,
  ConsoleLocalExecutionPort
} from './console-local-execution-contract'
import { consoleJobArtifact, ConsoleArtifactEvidenceError } from './console-folder-job-result'
import { consoleJobOutputDigest } from './console-job-digests'
import { consoleFolderRoundArtifact } from './console-folder-round-snapshot'

/** Retain exact execution evidence before publishing a result or releasing its worker. */
export async function publishConsoleJobArtifact(
  ctx: { port: ConsoleLocalExecutionPort },
  record: ConsoleLocalExecutionRecord,
  result: ConsoleLocalResult,
  signal: AbortSignal
): Promise<ConsoleLocalResult | null> {
  if (!ctx.port.publishFolderArtifact) {
    throw new Error('The signed artifact publisher is unavailable.')
  }
  let artifact
  try {
    artifact = record.attempt.job.artifactResult?.path.startsWith('folder-')
      ? await consoleFolderRoundArtifact(
          record.attempt.job,
          record.binding.attempt,
          record.attempt.worktreePath,
          result
        )
      : consoleJobArtifact(result)
  } catch (error) {
    if (!(error instanceof ConsoleArtifactEvidenceError)) {
      throw error
    }
    // Worker output that cannot be captured remains a failed execution, never an unrecordable retry loop.
    const failed = { ...result, status: 'failed' as const, output_tail: error.message }
    return { ...failed, output_digest: consoleJobOutputDigest(failed) }
  }
  const principal = record.run.console_job_principal!
  if ((await ctx.port.principal()) !== principal) {
    throw new Error('The signed-in person changed before artifact publication.')
  }
  const published = await ctx.port.publishFolderArtifact({
    binding: record.binding,
    principal,
    job: record.attempt.job,
    contentBase64: artifact.contentBase64
  })
  if (!published.ok) {
    throw new Error(published.error.message)
  }
  if (
    typeof published.data.fileId !== 'string' ||
    !/^tfl_[a-z0-9]{1,64}$/.test(published.data.fileId) ||
    published.data.sha256 !== artifact.sha256
  ) {
    throw new Error('The artifact receipt does not match the exact uploaded report.')
  }
  if (
    (record.attempt.job.artifactResult?.path === 'folder-snapshot.json' &&
      !published.data.folderSnapshot) ||
    (record.attempt.job.artifactResult?.path === 'folder-review.json' &&
      !published.data.reviewedSnapshot)
  ) {
    throw new Error('The artifact receipt omitted its server-derived folder snapshot binding.')
  }
  if (signal.aborted) {
    return null
  }
  if ((await ctx.port.principal()) !== principal) {
    throw new Error('The signed-in person changed during artifact publication.')
  }
  const retained = {
    ...result,
    file_id: published.data.fileId,
    artifact_sha256: published.data.sha256
  }
  return { ...retained, output_digest: consoleJobOutputDigest(retained) }
}
