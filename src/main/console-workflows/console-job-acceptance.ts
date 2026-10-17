import { consoleJobOutputDigest } from './console-job-digests'
export { consoleJobOutputDigest } from './console-job-digests'
import { runWorkflowHelperProcess } from '../runtime/workflow-script/workflow-process-group'
import type {
  ConsoleLocalJob,
  ConsoleLocalResult,
  ConsoleLocalTerminalProof
} from './console-local-execution-contract'
import {
  consoleJobPathViolations,
  snapshotConsoleJobChanges,
  isUntrackedConsoleRuntimePath
} from './console-job-changes'
import { readConsoleJobCandidate } from './console-job-candidate'
import { consoleJobCredentialsAbsent } from './console-job-credential-inspection'
import { consoleLoopVerdictRelativePath } from './console-loop-verdict'
import { consoleCurrentGitSource } from './console-current-git-source'
import { recordConsoleCurrentGitResult } from './console-current-git-result'

export async function runConsoleJobAcceptance(args: {
  job: ConsoleLocalJob
  cwd: string
  startSha: string
  branch: string
  workerSucceeded: boolean
  processProof?: ConsoleLocalTerminalProof
  sanitize: (value: string) => string
  signal?: AbortSignal
}): Promise<ConsoleLocalResult> {
  if (consoleCurrentGitSource(args.job)) {
    return recordConsoleCurrentGitResult(args)
  }
  let exitCode: number | null = null
  const output: string[] = []
  const artifact = args.job.artifactResult
  const loopVerdictPath = consoleLoopVerdictRelativePath(args.job)
  const ignoreUntracked =
    artifact || loopVerdictPath
      ? (file: string) =>
          file === loopVerdictPath || isUntrackedConsoleRuntimePath(file, args.job.ownedPaths)
      : undefined
  const candidate = await readConsoleJobCandidate(args.cwd, ignoreUntracked)
  let candidateCommitted = candidate.committed
  if (candidate.branch !== args.branch) {
    throw new Error('The acceptance candidate branch changed after admission.')
  }
  if (artifact && args.job.acceptanceCommands.length) {
    throw new Error('Artifact evidence cannot bypass executable acceptance commands.')
  }
  if (artifact) {
    const proof = args.processProof
    exitCode =
      proof?.kind === 'exited' && proof.exit_cause.kind === 'exited'
        ? proof.process_exit_code
        : null
    output.push(
      `Execution report only; original task acceptance requires independent verification. Observed process exit: ${exitCode ?? 'unverifiable'}.`
    )
  }
  if (!args.workerSucceeded) {
    output.push('The worker reported failure; acceptance was not executed.')
  }
  if (args.workerSucceeded && !artifact && args.job.acceptanceCommands.length === 0) {
    exitCode = null
    output.push('The server did not provide an executable acceptance contract.')
  }
  if (args.workerSucceeded) {
    for (const command of args.job.acceptanceCommands) {
      if (args.signal?.aborted) {
        break
      }
      const serialized = JSON.stringify(command)
      if (args.sanitize(serialized) !== serialized) {
        exitCode = null
        output.push('The acceptance command contains protected data.')
        break
      }
      try {
        const result = await runWorkflowHelperProcess({
          ...command,
          cwd: args.cwd,
          signal: args.signal,
          maxOutputBytes: 32_768,
          outputCapture: 'tail',
          terminationBarrier: true
        })
        output.push(
          `${JSON.stringify([command.program, ...command.args])}: exit ${result.code}\n${result.stdout}\n${result.stderr}`
        )
        exitCode = result.code
        if (result.code !== 0 || result.timedOut) {
          exitCode = result.code === 0 ? null : result.code
          break
        }
      } catch {
        exitCode = null
        output.push('The acceptance process could not be started.')
        break
      }
    }
  }
  const changedFiles = await snapshotConsoleJobChanges(args.cwd, args.startSha, ignoreUntracked)
  const violations = consoleJobPathViolations(changedFiles, args.job.ownedPaths, args.job.readOnly)
  const head = candidate.head
  if (violations.length) {
    output.push(`Write scope violations: ${violations.join(', ')}`)
  }
  const credentialsAbsent =
    exitCode !== 0 ||
    args.job.readOnly ||
    (await consoleJobCredentialsAbsent(args.cwd, args.startSha, head, args.sanitize, args.signal))
  if (!credentialsAbsent) {
    output.push(
      'The unpublished changes did not pass credential inspection; publication was refused.'
    )
  }
  const after = await readConsoleJobCandidate(args.cwd, ignoreUntracked)
  candidateCommitted &&= after.committed
  if (!candidateCommitted) {
    output.push('Commit repository changes before verifying a reproducible candidate.')
  }
  const sameCandidate = after.head === head && after.branch === candidate.branch
  if (!sameCandidate) {
    output.push(
      'The candidate HEAD or branch changed during acceptance; verify the current candidate again.'
    )
  }
  const result: Omit<ConsoleLocalResult, 'output_digest'> = {
    status:
      args.workerSucceeded &&
      exitCode === 0 &&
      candidateCommitted &&
      sameCandidate &&
      credentialsAbsent &&
      violations.length === 0 &&
      !args.signal?.aborted
        ? 'done'
        : 'failed',
    exit_code: exitCode,
    ...(exitCode === null ? {} : { result_exit_code: exitCode }),
    output_tail: args.sanitize(output.join('\n')).slice(-16_000),
    candidate_sha: head,
    branch: args.branch,
    pr_url: args.job.revision?.reviewUrl ?? null,
    pr_number: args.job.revision?.reviewNumber ?? null,
    changed_files: changedFiles,
    owned_paths_violations: violations,
    terminal_proof:
      artifact && args.processProof
        ? args.processProof
        : { kind: 'acceptance_process', exit_code: exitCode }
  }
  if (args.sanitize(JSON.stringify(result)) !== JSON.stringify(result)) {
    throw new Error('The result contains protected artifact metadata and cannot be published.')
  }
  return { ...result, output_digest: consoleJobOutputDigest(result) }
}
