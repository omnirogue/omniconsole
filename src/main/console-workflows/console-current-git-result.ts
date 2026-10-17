import { gitExecFileAsync } from '../git/runner'
import { consoleCurrentGitSource } from './console-current-git-source'
import { consoleFolderCandidate } from './console-folder-round-snapshot'
import { currentConsoleFolderDigest } from './console-folder-hydration-guard'
import { consoleJobOutputDigest } from './console-job-digests'
import { isUntrackedConsoleRuntimePath, snapshotConsoleJobChanges } from './console-job-changes'
import { consoleLoopVerdictRelativePath } from './console-loop-verdict'
import type {
  ConsoleLocalJob,
  ConsoleLocalResult,
  ConsoleLocalTerminalProof
} from './console-local-execution-contract'

/** Selected snapshots carry bytes, so neither staged changes nor a worker commit become Git candidate proof. */
export async function recordConsoleCurrentGitResult(args: {
  job: ConsoleLocalJob
  cwd: string
  startSha: string
  branch: string
  workerSucceeded: boolean
  processProof?: ConsoleLocalTerminalProof
  sanitize: (value: string) => string
  signal?: AbortSignal
}): Promise<ConsoleLocalResult> {
  const current = consoleCurrentGitSource(args.job)
  if (!current || current.git.head_sha !== args.startSha) {
    throw new Error('The Git snapshot result has no exact captured source HEAD.')
  }
  const [head, branch] = await Promise.all([
    gitExecFileAsync(['rev-parse', '--verify', 'HEAD'], { cwd: args.cwd }),
    gitExecFileAsync(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: args.cwd })
  ])
  const unchangedHead = head.stdout.trim() === args.startSha && branch.stdout.trim() === args.branch
  const verdict = consoleLoopVerdictRelativePath(args.job)
  const changed = await snapshotConsoleJobChanges(
    args.cwd,
    args.startSha,
    (path) => path === verdict || isUntrackedConsoleRuntimePath(path, args.job.ownedPaths)
  )
  const violations = changed.filter((path) => !current.paths.includes(path))
  if (args.job.readOnly) {
    const candidate = consoleFolderCandidate(args.job)
    const expected = new Map(
      candidate
        ? candidate.manifest.map((file) => [file.path, file.sha256])
        : current.source.files.map((file) => [file.target_path, file.file.sha256])
    )
    for (const path of current.paths) {
      try {
        if ((await currentConsoleFolderDigest(args.cwd, path)) !== (expected.get(path) ?? null)) {
          violations.push(path)
        }
      } catch {
        violations.push(path)
      }
    }
  }
  const proof = args.processProof
  const exitCode = proof?.process_exit_code ?? null
  const success =
    args.workerSucceeded &&
    proof?.kind === 'exited' &&
    proof.exit_cause.kind === 'exited' &&
    exitCode === 0 &&
    unchangedHead &&
    !violations.length &&
    !args.signal?.aborted
  const result: ConsoleLocalResult = {
    status: success ? 'done' : 'failed',
    exit_code: exitCode,
    ...(exitCode === null ? {} : { result_exit_code: exitCode }),
    output_tail: args
      .sanitize(
        [
          'Selected file snapshot only; independent verification still determines task completion.',
          ...(!unchangedHead
            ? ['The worker changed the captured Git HEAD or its isolated branch.']
            : []),
          ...(violations.length ? [`Write scope violations: ${violations.join(', ')}`] : [])
        ].join('\n')
      )
      .slice(-16_000),
    candidate_sha: null,
    branch: null,
    pr_url: null,
    pr_number: null,
    changed_files: changed,
    owned_paths_violations: [...new Set(violations)].sort(),
    terminal_proof: proof ?? { kind: 'acceptance_process', exit_code: null },
    output_digest: ''
  }
  return { ...result, output_digest: consoleJobOutputDigest(result) }
}
