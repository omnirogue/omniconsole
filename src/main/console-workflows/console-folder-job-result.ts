import { createHash } from 'node:crypto'
import type {
  ConsoleLocalJob,
  ConsoleLocalResult,
  ConsoleLocalTerminalProof
} from './console-local-execution-contract'
import { canonicalDigestJson, consoleJobOutputDigest } from './console-job-digests'

export function recordConsoleFolderJobResult(args: {
  job: ConsoleLocalJob
  workerSucceeded: boolean
  proof: ConsoleLocalTerminalProof
  findings: { worker_report: string }
  sanitize: (value: string) => string
}): ConsoleLocalResult {
  const { job, workerSucceeded, proof, findings, sanitize } = args
  if (job.workspace?.kind !== 'folder' || job.acceptanceCommands.length) {
    throw new Error('Folder execution requires its admitted process-evidence contract.')
  }
  const exited = proof.kind === 'exited' && proof.exit_cause.kind === 'exited'
  const exitCode = proof.process_exit_code
  const result: ConsoleLocalResult = {
    status: workerSucceeded && exited && exitCode === 0 ? 'done' : 'failed',
    exit_code: exitCode,
    ...(Number.isInteger(exitCode) ? { result_exit_code: exitCode! } : {}),
    output_tail: sanitize(
      `Folder worker reported ${workerSucceeded ? 'success' : 'failure'}; observed process exit ${exitCode ?? proof.exit_cause.kind}.\n${findings.worker_report}`
    ).slice(-16_000),
    worker_report: findings.worker_report,
    ...(job.action === 'review' ? { review_text: findings.worker_report } : {}),
    candidate_sha: null,
    branch: null,
    pr_url: null,
    pr_number: null,
    changed_files: [],
    owned_paths_violations: [],
    terminal_proof: proof,
    output_digest: ''
  }
  if (sanitize(JSON.stringify(result)) !== JSON.stringify(result)) {
    throw new Error('The result contains protected metadata and cannot be published.')
  }
  return { ...result, output_digest: consoleJobOutputDigest(result) }
}

/** The worker's own output cannot be captured as bounded evidence: a recorded failed result, never an unrecordable throw. */
export class ConsoleArtifactEvidenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConsoleArtifactEvidenceError'
  }
}

export class ConsoleArtifactEvidenceLimitError extends ConsoleArtifactEvidenceError {
  constructor() {
    super('The result artifact exceeds its bounded evidence limit; no artifact was uploaded.')
    this.name = 'ConsoleArtifactEvidenceLimitError'
  }
}

function boundedArtifactPaths(paths: string[]): string[] {
  const retained: string[] = []
  let bytes = 2
  for (const path of paths) {
    const size = Buffer.byteLength(JSON.stringify(path)) + 1
    if (retained.length >= 128 || bytes + size > 8192) {
      break
    }
    retained.push(path)
    bytes += size
  }
  return retained
}

export function consoleJobArtifact(result: ConsoleLocalResult): {
  contentBase64: string
  sha256: string
} {
  if (typeof result.worker_report !== 'string' || !('process_identity' in result.terminal_proof)) {
    throw new Error('The folder artifact requires its exact worker report and physical exit proof.')
  }
  const changedFiles = boundedArtifactPaths(result.changed_files)
  const violations = boundedArtifactPaths(result.owned_paths_violations)
  const outputTail = result.output_tail.slice(-2000)
  const bytes = Buffer.from(
    canonicalDigestJson({
      status: result.status,
      exit_code: result.exit_code,
      ...(Number.isInteger(result.result_exit_code)
        ? { result_exit_code: result.result_exit_code }
        : {}),
      worker_report: result.worker_report,
      terminal_proof: result.terminal_proof,
      ...(result.candidate_sha
        ? {
            candidate_sha: result.candidate_sha,
            branch: result.branch,
            changed_files: changedFiles,
            changed_files_count: result.changed_files.length,
            changed_files_truncated: changedFiles.length !== result.changed_files.length,
            owned_paths_violations: violations,
            owned_paths_violations_count: result.owned_paths_violations.length,
            owned_paths_violations_truncated:
              violations.length !== result.owned_paths_violations.length,
            output_tail: outputTail,
            output_tail_truncated: outputTail !== result.output_tail
          }
        : {})
    })
  )
  if (bytes.length > 65_536) {
    throw new ConsoleArtifactEvidenceLimitError()
  }
  return {
    contentBase64: bytes.toString('base64'),
    sha256: createHash('sha256').update(bytes).digest('hex')
  }
}
