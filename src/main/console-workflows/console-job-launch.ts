import { assertLocalOmpRoute } from '../omp/omp-route-preflight'
import type { ConsoleLocalExecutionView } from '../../shared/console-local-execution'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import type { OrchestrationCaller } from '../runtime/build-review/build-review-rpc-call'
import { createDesktopCoordinator } from '../runtime/orchestration/desktop-coordinator'
import { admitConsoleJobRun } from './console-job-admission'
import type { ConsoleLocalActivation } from './console-local-execution-contract'
import type { ConsoleJobWorktree } from './console-job-worktree'
import {
  assertConsoleLoopVerdictContract,
  consoleLoopVerdictRelativePath
} from './console-loop-verdict'
import { consoleFolderCandidate } from './console-folder-round-snapshot'
import { consoleCurrentGitSource } from './console-current-git-source'

export function consoleJobExecutionBrief(
  activation: ConsoleLocalActivation,
  sanitize: (value: string) => string,
  preparedInputPaths?: string[]
): string {
  const { job, binding } = activation
  assertConsoleLoopVerdictContract(job)
  const loopVerdictPath = consoleLoopVerdictRelativePath(job)
  const folderCandidate = consoleFolderCandidate(job)
  const currentGit = consoleCurrentGitSource(job)
  const brief = [
    `Durable card ${binding.taskId}; workflow ${binding.workflowId}; job ${binding.jobId}; attempt ${binding.attempt}; generation ${binding.leaseGeneration}.`,
    job.prompt,
    '',
    job.brief,
    '',
    `Acceptance:\n${job.acceptance}`,
    `Explicit inputs:\n${JSON.stringify(job.inputs, null, 2)}`,
    ...(preparedInputPaths?.length
      ? [`Prepared input files:\n${JSON.stringify(preparedInputPaths, null, 2)}`]
      : []),
    ...(folderCandidate
      ? [
          `Current folder candidate: snapshot ${folderCandidate.snapshot_digest}; artifact ${folderCandidate.artifact.sha256}; selected files ${JSON.stringify(folderCandidate.manifest)}. The initial current_source files describe sealed scope and history; inspect the hydrated workspace bytes as the current candidate.`
        ]
      : []),
    ...(job.workspace?.kind === 'folder' ? [`Workspace folder: ${job.workspace.path}.`] : []),
    `Owned paths: ${JSON.stringify(job.ownedPaths)}.`,
    job.readOnly
      ? loopVerdictPath
        ? `Read only: do not edit reviewed source, commit, push, publish a review, or send messages to people. Control-plane reporting only: write the exact graph-owned verdict metadata file at ${loopVerdictPath} and send the required worker_done to the coordinator.`
        : 'Read only: do not edit reviewed source, commit, push, publish a review, or send messages to people. Send only the required worker_done to the coordinator.'
      : currentGit
        ? `Edit only the selected snapshot paths ${JSON.stringify(currentGit.paths)} in this isolated worktree. Do not commit, push, or change branches. Report the actual selected file changes and findings in worker_done; the IDE retains the bytes for independent verification.`
        : job.workspace?.kind === 'folder'
          ? 'Write only inside the owned paths in this folder. Report your actual changes and results in worker_done.'
          : job.artifactResult
            ? 'Write only inside the owned paths and commit changes on this branch. Include actual results, evidence references and unfinished obligations in worker_done. The IDE retains your report for independent verification; it does not create a pull request. Perform publication or delivery only when the original task authorizes it.'
            : 'Write only inside the owned paths. Commit the requested changes on this branch; the IDE will run acceptance and publish the review request.',
    'Report execution evidence. The hub alone verifies or completes the card.',
    ...(job.action === 'review'
      ? [
          ...(loopVerdictPath
            ? [
                `Write the canonical loop verdict to ${loopVerdictPath}: {"verdict":"agree|disagree","blockers":[],"gaps":[],"notes":"..."}. The IDE reads that exact file; terminal output and OMNI_REVIEW_RESULT cannot substitute for it.`
              ]
            : []),
          'Include the server review report object in your worker_done body: {"verdict":"all_gaps_closed|gaps|inconclusive","findings":[{"id":"...","title":"...","detail":"...","evidence":"...","required":true,"closed":false}],"summary":"..."}. The server validates this evidence; report no inferred approval.'
        ]
      : [])
  ].join('\n')
  if (sanitize(brief) !== brief) {
    throw new Error(
      'The stored job instructions contain protected data; execution was not started.'
    )
  }
  return brief
}

export async function launchConsoleJob(args: {
  runtime: OrcaRuntimeService
  call: OrchestrationCaller
  activation: ConsoleLocalActivation
  worktree: ConsoleJobWorktree
  preparedInputPaths?: string[]
  sanitize: (value: string) => string
  /** The signed-in person's computed principal, re-read when the binding is installed. */
  livePrincipal: () => Promise<string | null>
}): Promise<ConsoleLocalExecutionView> {
  const { job } = args.activation
  if (job.provider === 'omp') {
    await assertLocalOmpRoute(args.runtime, `id:${args.worktree.id}`, job)
  }
  const executionBrief = consoleJobExecutionBrief(
    args.activation,
    args.sanitize,
    args.preparedInputPaths
  )
  const handle = await createDesktopCoordinator(
    args.runtime,
    args.worktree.id,
    'Console workflow coordinator',
    { launchCause: { trigger: 'workflow', reference: { consoleJobId: job.id } } }
  )
  // Why: the binding never crosses the RPC surface. `orchestration.runCreate`
  // refuses console job parameters outright, so this main-only admission is the
  // only way a Run becomes `hub_dispatched` for a console job.
  const created = await admitConsoleJobRun({
    runtime: args.runtime,
    activation: args.activation,
    coordinatorHandle: handle,
    objective: job.title,
    livePrincipal: args.livePrincipal
  })
  if (!created.projectionTaskId) {
    throw new Error('The runtime did not preserve the admitted card projection.')
  }
  const started = await args.call<{
    dispatchId: string
    state: string
    lastError?: string
  }>('orchestration.workerStart', {
    task: created.projectionTaskId,
    from: handle,
    worktree: `id:${args.worktree.id}`,
    agent: job.provider,
    model: job.model,
    ...(job.openrouterCandidates !== undefined
      ? { openrouterCandidates: job.openrouterCandidates }
      : {}),
    ...(job.effort ? { effort: job.effort } : {}),
    executionBrief,
    consoleExecution: {
      job,
      attemptStartSha: args.worktree.startSha,
      worktreeId: args.worktree.id,
      worktreePath: args.worktree.path,
      branch: args.worktree.branch,
      ...(args.preparedInputPaths?.length ? { preparedInputPaths: args.preparedInputPaths } : {})
    },
    timeoutMs: 180_000
  })
  const worker = args.runtime.getOrchestrationDb().getWorkerDispatch(started.dispatchId)
  return {
    jobId: job.id,
    workflowId: job.workflowId,
    cardId: job.taskId,
    runId: created.run.id,
    dispatchId: started.dispatchId,
    terminalHandle: worker?.agent_terminal_handle ?? null,
    worktreeId: args.worktree.id,
    branch: args.worktree.branch,
    state: started.state === 'ready' ? 'running' : 'unverifiable',
    ...(started.state !== 'ready'
      ? { error: args.sanitize(started.lastError ?? `Worker start returned ${started.state}.`) }
      : {})
  }
}
