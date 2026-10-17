import type { OmpExecutionReceipt } from '../../shared/omp-execution-receipt'
import type { ConsoleLocalStartRequest } from '../../shared/console-local-execution'
import type { ConsoleJobBinding, ConsoleWorkflowResult } from '../../shared/console-workflow-types'
import type { HostedReviewProvider } from '../../shared/hosted-review'
import type { PtyLaunchGateReceipt } from '../../shared/pty-launch-gate'

export type ConsoleAcceptanceCommand = {
  program: string
  args: string[]
  timeoutMs: number
}

export type ConsoleWorkflowLoopVerdict = {
  verdict: 'agree' | 'disagree'
  blockers: string[]
  gaps: string[]
  notes: string
}

export type ConsoleFolderSnapshotManifest = {
  snapshotDigest: string
  manifest: { path: string; mode: number; sha256: string; sizeBytes: number }[]
}

export type ConsoleFolderReviewedSnapshot =
  | { schemaVersion: 1; kind: 'current_task_files'; snapshotDigest: string }
  | {
      schemaVersion: 1
      kind: 'accepted_folder_snapshot'
      snapshotDigest: string
      artifactSha256: string
      sourceJobId: string
      sourceAttempt: number
    }

/** Main-only normalized port; a transport must validate the server's exact executable contract. */
export type ConsoleLocalJob = {
  artifactResult?: {
    path: 'work-result.json' | 'folder-snapshot.json' | 'folder-review.json'
    format: 'json'
    maxBytes: 65536
  }
  id: string
  taskId: string
  workflowId: string
  digest: string
  state: string
  placement: 'local' | 'fleet'
  provider: 'codex' | 'claude' | 'grok' | 'omp'
  model: string
  openrouterCandidates?: string[]
  effort?: string
  title: string
  workspace?: { kind: 'folder'; path: string }
  repo: string | null
  baseSha?: string | null
  baseBranch: string | null
  prompt: string
  brief: string
  acceptance: string
  acceptanceCommands: ConsoleAcceptanceCommand[]
  inputs: unknown[]
  ownedPaths: string[] | null
  readOnly: boolean
  action?: 'execute' | 'review' | 'repair'
  reviewProvider?: HostedReviewProvider
  revision?: {
    confirmed: boolean
    branch: string
    reviewUrl: string
    reviewNumber: number
  }
}

export type ConsoleLocalActivation = {
  job: ConsoleLocalJob
  binding: ConsoleJobBinding
  principal: string
}

export type ConsoleLocalResult = {
  execution?: OmpExecutionReceipt
  status: 'pr_open' | 'failed' | 'cancelled' | 'done'
  exit_code: number | null
  result_exit_code?: number
  output_tail: string
  worker_report?: string
  review_text?: string
  file_id?: string
  artifact_sha256?: string
  workflow_loop_verdict?: ConsoleWorkflowLoopVerdict
  candidate_sha: string | null
  branch: string | null
  pr_url: string | null
  pr_number: number | null
  changed_files: string[]
  owned_paths_violations: string[]
  terminal_proof: { kind: string; exit_code: number | null } | ConsoleLocalTerminalProof
  output_digest: string
}

export type ConsoleLocalTerminalProof = {
  kind: 'exited' | 'not_started'
  process_identity: {
    pid: number
    started_at: string
    runner_instance: string
  }
  process_exited: true
  process_exit_code: number | null
  exit_cause:
    | { kind: 'exited'; exit_code: number }
    | { kind: 'signaled'; signal: number }
    | { kind: 'operator_close' }
  observed_at: string
  launch_gate_closed?: true
}

export type ConsoleLocalExecutionPort = {
  captureLaunchAuthority?(): Promise<{
    principal: string
    isCurrent(): boolean
  } | null>
  prepareInputs?(job: ConsoleLocalJob, workspacePath: string): Promise<string[]>
  hydrateFolderCandidate?(activation: ConsoleLocalActivation, workspacePath: string): Promise<void>
  publishFolderArtifact?(input: {
    binding: ConsoleJobBinding
    principal: string
    job: ConsoleLocalJob
    contentBase64: string
  }): Promise<
    ConsoleWorkflowResult<{
      fileId: string
      sha256: string
      folderSnapshot?: ConsoleFolderSnapshotManifest
      reviewedSnapshot?: ConsoleFolderReviewedSnapshot
    }>
  >
  startProcess?(input: {
    binding: ConsoleJobBinding
    principal: string
    gate: PtyLaunchGateReceipt
    job: ConsoleLocalJob
    projectDir: string
    baseSha: string | null
    inputDigest: string
  }): Promise<ConsoleWorkflowResult<ConsoleJobBinding>>
  getReadyJob(request: ConsoleLocalStartRequest): Promise<ConsoleWorkflowResult<ConsoleLocalJob>>
  activate(
    request: ConsoleLocalStartRequest
  ): Promise<ConsoleWorkflowResult<ConsoleLocalActivation>>
  inspect(
    binding: ConsoleJobBinding,
    principal: string
  ): Promise<ConsoleWorkflowResult<{ cancelled: boolean }>>
  result(
    binding: ConsoleJobBinding,
    principal: string,
    result: ConsoleLocalResult
  ): Promise<ConsoleWorkflowResult<null>>
  cancelled(binding: ConsoleJobBinding, principal: string): Promise<ConsoleWorkflowResult<null>>
  principal(): Promise<string | null>
  sanitize(value: string): string
}
