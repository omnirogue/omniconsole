import type {
  ConsoleLocalExecutionView,
  ConsoleLocalStartRequest
} from '../../shared/console-local-execution'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import type { OrchestrationCaller } from '../runtime/build-review/build-review-rpc-call'
import type { ConsoleLocalExecutionPort } from './console-local-execution-contract'
import type { ConsoleLocalExecutionRecord } from './console-local-execution-state'
import type { ConsoleResultJournal } from './console-job-monitor'
import { consoleLocalJobSchema } from './console-local-execution-schema'
import { prepareConsoleJobWorktree, resolveConsoleJobRepository } from './console-job-worktree'
import { consoleJobExecutionBrief, launchConsoleJob } from './console-job-launch'
import { assertConsoleLoopVerdictContract } from './console-loop-verdict'
import { resolveConsoleFolderJobWorkspace } from './console-folder-job-workspace'
import { consoleCurrentGitSource } from './console-current-git-source'
import { materializeConsoleCurrentGitSource } from './console-current-git-materialization'

export async function activateApprovedConsoleJob(args: {
  runtime: OrcaRuntimeService
  call: OrchestrationCaller
  port: ConsoleLocalExecutionPort
  results: ConsoleResultJournal
  records(): Promise<ConsoleLocalExecutionRecord[]>
  request: ConsoleLocalStartRequest
  onActivationAttempt?(): void
}): Promise<ConsoleLocalExecutionView> {
  const { runtime, call, port, results, records, request } = args
  const ready = await port.getReadyJob(request)
  if (!ready.ok) {
    throw new ConsoleLocalRefusal(ready.error.code, ready.error.message)
  }
  const job = consoleLocalJobSchema.parse(ready.data)
  if (
    job.id !== request.jobId ||
    job.workflowId !== request.workflowId ||
    job.digest !== request.approvedDigest
  ) {
    throw new Error(
      'The ready job does not match the explicitly approved graph. Refresh its preview.'
    )
  }
  if (job.placement !== 'local') {
    throw new Error('This job is placed on the fleet. Observe it through the console workflow.')
  }
  if (job.state !== 'ready') {
    throw new Error('The named job is not ready for explicit local activation.')
  }
  if (port.sanitize(JSON.stringify(job)) !== JSON.stringify(job)) {
    throw new Error('The stored job contains protected data.')
  }
  if (
    (await records()).some(
      (record) => record.binding.jobId === job.id && !results.read(record.worker.dispatch_id)
    )
  ) {
    throw new Error(
      'This job already has a bound local Dispatch. Inspect that attempt before starting another.'
    )
  }
  // Why before the hub claim: a loop reviewer without a verdict directory must stay queued, not become a claimed attempt that can only fail.
  assertConsoleLoopVerdictContract(job)
  const currentGit = consoleCurrentGitSource(job)
  const folder =
    job.workspace?.kind === 'folder'
      ? await resolveConsoleFolderJobWorkspace(runtime, request.worktree, job)
      : null
  const repo = folder ? null : await resolveConsoleJobRepository(runtime, request.worktree, job)
  args.onActivationAttempt?.()
  const activated = await port.activate(request)
  if (!activated.ok) {
    throw new ConsoleLocalRefusal(activated.error.code, activated.error.message)
  }
  const activation = { ...activated.data, job: consoleLocalJobSchema.parse(activated.data.job) }
  if (
    JSON.stringify({ ...activation.job, state: job.state }) !== JSON.stringify(job) ||
    activation.binding.jobId !== job.id ||
    activation.binding.taskId !== job.taskId ||
    activation.binding.workflowId !== job.workflowId ||
    activation.principal !== (await port.principal())
  ) {
    throw new Error('The activation receipt changed the approved job or signed-in person.')
  }
  if (port.sanitize(JSON.stringify(activation)) !== JSON.stringify(activation)) {
    throw new Error('The activation receipt contains protected data.')
  }
  consoleJobExecutionBrief(activation, port.sanitize)
  const worktree = folder
    ? await resolveConsoleFolderJobWorkspace(runtime, `id:${folder.id}`, job)
    : await prepareConsoleJobWorktree(runtime, repo!, job)
  if (folder && worktree.path !== folder.path) {
    throw new Error('The selected folder changed during activation; the worker was not started.')
  }
  let preparedInputPaths: string[] | undefined
  if (currentGit?.requiresCandidate) {
    if (!port.hydrateFolderCandidate) {
      throw new Error('The accepted Git repair snapshot cannot be materialized by this executor.')
    }
    await port.hydrateFolderCandidate(activation, worktree.path)
    preparedInputPaths = []
  } else if (currentGit) {
    preparedInputPaths = (await port.prepareInputs?.(activation.job, worktree.path)) ?? []
    await materializeConsoleCurrentGitSource(activation.job, worktree.path, preparedInputPaths)
  } else {
    if (folder) {
      await port.hydrateFolderCandidate?.(activation, worktree.path)
    }
    preparedInputPaths = await port.prepareInputs?.(activation.job, worktree.path)
  }
  const view = await launchConsoleJob({
    runtime: runtime,
    call: call,
    activation,
    worktree,
    preparedInputPaths,
    sanitize: port.sanitize,
    livePrincipal: () => port.principal()
  })
  return view
}

export class ConsoleLocalRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly launchDisposition?: 'not-started' | 'unverifiable'
  ) {
    super(message)
  }
}
