import type { OrcaRuntimeService } from '../omni-runtime'
import type { OrchestrationDb } from '../orchestration/db'
import {
  createOrchestrationCaller,
  type OrchestrationCaller
} from '../build-review/build-review-rpc-call'
import type { AgentSessionProcessIdentity } from '../../../shared/agent-session-record'
import { splitWorktreeIdForFilesystem } from '../../../shared/worktree/id'
import { createWorkflowProgramContext } from './workflow-program-context'
import { runWorkflowPreset } from './workflow-preset-runner'
import { WorkflowScriptSlots } from './workflow-script-slots'
import type { WorkflowCheckpointStore } from './workflow-checkpoint-store'
import type {
  LocalWorkflowHostSnapshot,
  LocalWorkflowWorkingStart
} from './local-workflow-host-snapshot'
import type { WorkflowExecutionOutcome } from './workflow-execution-service'
import { executeWorkingAgentCall } from './workflow-working-agent-executor'
import { workingCouncilCandidatePacket } from './workflow-working-candidate-packet'
import { admitWorkingAgentGitSource } from './workflow-working-source-admission'
import { finishWorkingRun, getWorkingRun } from './workflow-working-run-binding'
import { ensureWorkingWorkflowRun } from './workflow-working-run-session'

type Active = { abort: AbortController; completion: Promise<WorkflowExecutionOutcome> }
/** Independent writable execution path; frozen process-attempt records remain untouched. */
export class WorkingWorkflowExecutionService {
  private readonly active = new Map<string, Active>()
  private readonly completed = new Map<string, WorkflowExecutionOutcome>()
  private readonly callRpc: OrchestrationCaller

  constructor(
    private readonly options: {
      db: OrchestrationDb
      runtime: OrcaRuntimeService
      store: WorkflowCheckpointStore
      slots: WorkflowScriptSlots
      callRpc?: OrchestrationCaller
      progress?: (executionId: string, event: { phase?: string; message?: string }) => void
    }
  ) {
    this.callRpc = options.callRpc ?? createOrchestrationCaller(options.runtime)
  }

  start(request: LocalWorkflowWorkingStart): string {
    if (
      request.snapshot.capability?.mode !== 'working-agent' ||
      !request.snapshot.host.workingSource
    ) {
      throw new Error('Working workflow requires a pinned writable source snapshot')
    }
    if (
      (request.workspaceId && request.workspaceId !== request.snapshot.host.workspaceId) ||
      (request.sourceBase &&
        request.sourceBase !== request.snapshot.host.workingSource.sourceBase) ||
      (request.sourceDiffDigest &&
        request.sourceDiffDigest !== request.snapshot.host.workingSource.sourceDiffDigest)
    ) {
      throw new Error('Working workflow source changed between admission and Start')
    }
    const prior = this.options.store.findStart(request.conversationId, request.requestId)
    const id = this.options.store.create(request)
    if (!prior) {
      this.execute(id, request.fence, false)
    }
    return id
  }

  isActive(executionId: string): boolean {
    return this.active.has(executionId)
  }

  wait(executionId: string): Promise<WorkflowExecutionOutcome> {
    const active = this.active.get(executionId)
    if (active) {
      return active.completion.then((outcome) => structuredClone(outcome))
    }
    const completed = this.completed.get(executionId)
    if (completed) {
      return Promise.resolve(structuredClone(completed))
    }
    return Promise.reject(new Error('Working workflow requires host recovery before waiting'))
  }

  async recoverInterrupted(
    executionId: string,
    fence: number,
    owner: AgentSessionProcessIdentity
  ): Promise<WorkflowExecutionOutcome & { fence: number }> {
    const claimedFence = await this.resumeInterrupted(executionId, fence, owner)
    const outcome = await this.wait(executionId)
    return { ...outcome, fence: claimedFence }
  }

  /** Claims an interrupted run and runs it again from its journal; wait() reads the outcome. */
  async resumeInterrupted(
    executionId: string,
    fence: number,
    owner: AgentSessionProcessIdentity
  ): Promise<number> {
    if (this.active.has(executionId)) {
      throw new Error('Working workflow is already active')
    }
    const claimedFence = await this.options.store.claimOwner(executionId, fence, owner)
    this.execute(executionId, claimedFence, true)
    return claimedFence
  }

  async recoverCompleted(executionId: string, fence: number): Promise<WorkflowExecutionOutcome> {
    if (this.active.has(executionId)) {
      throw new Error('Working workflow is still active')
    }
    const execution = this.options.store.inspect(executionId, fence)
    const row = getWorkingRun(this.options.db, executionId)
    if (execution.state !== 'completed' || row?.state !== 'completed' || !row.result_json) {
      throw new Error('Completed working workflow result evidence is missing')
    }
    return { state: 'completed', result: JSON.parse(row.result_json) }
  }

  resume(executionId: string, fence: number): void {
    if (this.active.has(executionId)) {
      throw new Error('Working workflow is still draining')
    }
    this.options.store.resume(executionId, fence)
    this.execute(executionId, fence, true)
  }

  /** `finish` is refused by the store: a working run has no graph final step to finish into. */
  control(executionId: string, fence: number, action: 'pause' | 'stop' | 'finish'): string {
    const state = this.options.store.requestControl(executionId, fence, action)
    if (action === 'stop') {
      this.active.get(executionId)?.abort.abort(new Error('Working workflow stopped'))
    }
    return state
  }

  private execute(executionId: string, fence: number, recovering: boolean): void {
    const abort = new AbortController()
    const completion = this.run(executionId, fence, recovering, abort.signal)
      .then((outcome) => {
        this.completed.set(executionId, structuredClone(outcome))
        return outcome
      })
      .finally(() => this.active.delete(executionId))
    this.completed.delete(executionId)
    this.active.set(executionId, { abort, completion })
  }

  private async run(
    executionId: string,
    fence: number,
    recovering: boolean,
    signal: AbortSignal
  ): Promise<WorkflowExecutionOutcome> {
    const { db, store, slots } = this.options
    try {
      const admitted = store.inspect(executionId, fence)
      const snapshot = admitted.snapshot as LocalWorkflowHostSnapshot
      if (
        !['running', 'pausing', 'paused'].includes(admitted.state) ||
        snapshot.capability?.mode !== 'working-agent' ||
        !snapshot.host.workingSource
      ) {
        throw new Error('Working execution is not admitted')
      }
      if (admitted.state === 'paused') {
        return { state: 'paused' }
      }
      if (admitted.state === 'pausing' && !getWorkingRun(db, executionId)) {
        return { state: store.requestControl(executionId, fence, 'pause') }
      }
      const existingCalls = db.db
        .prepare('SELECT COUNT(*) AS count FROM local_workflow_worker_calls WHERE execution_id=?')
        .get(executionId) as { count: number }
      if (!existingCalls.count) {
        const sourcePath = splitWorktreeIdForFilesystem(snapshot.host.workspaceId)?.worktreePath
        if (!sourcePath) {
          throw new Error('Working execution lost its Git source workspace')
        }
        const currentSource = await admitWorkingAgentGitSource(sourcePath)
        if (
          currentSource.sourceBase !== snapshot.host.workingSource.sourceBase ||
          currentSource.sourceDiffDigest !== snapshot.host.workingSource.sourceDiffDigest
        ) {
          throw new Error('Working source changed after admission; no workers were launched')
        }
      }
      const run = await ensureWorkingWorkflowRun({
        db,
        runtime: this.options.runtime,
        callRpc: this.callRpc,
        executionId,
        snapshot,
        recovering,
        signal
      })
      const localSlots = new WorkflowScriptSlots(snapshot.limits?.concurrency ?? slots.limit)
      const seat = (seatId: string) => {
        const resolved = snapshot.seats.find((candidate) => candidate.id === seatId)
        if (!resolved) {
          throw new Error(`Missing frozen workflow seat ${seatId}`)
        }
        return resolved
      }
      const context = createWorkflowProgramContext({
        agent: (call) =>
          localSlots.run(
            () =>
              slots.run(() => {
                if (store.inspect(executionId, fence).state === 'pausing') {
                  const previous = db.db
                    .prepare(
                      'SELECT 1 FROM local_workflow_worker_calls WHERE execution_id=? AND call_id=?'
                    )
                    .get(executionId, call.id)
                  if (!previous) {
                    throw new Error('Working workflow is pausing; missing call waits for resume')
                  }
                }
                return executeWorkingAgentCall({
                  db,
                  callRpc: this.callRpc,
                  executionId,
                  runId: run.run_id!,
                  coordinatorTerminalHandle: run.coordinator_handle,
                  workspaceId: run.workspace_id,
                  sourceBase: run.source_base,
                  sourceDiffDigest: run.source_diff_digest,
                  seat: seat(call.seatId),
                  call,
                  signal
                })
              }, signal),
            signal
          ),
        phase: (phase) => this.options.progress?.(executionId, { phase }),
        log: (message) => this.options.progress?.(executionId, { message }),
        guard: () => {
          signal.throwIfAborted()
          const state = store.inspect(executionId, fence).state
          if (state !== 'running' && !(recovering && state === 'pausing')) {
            throw new Error('Working workflow admission paused')
          }
        },
        isFatal: () => true
      })
      const result = await runWorkflowPreset(context, admitted.preset, snapshot, {
        candidatePacket: (candidateSeat, answer, label) =>
          workingCouncilCandidatePacket(db, executionId, candidateSeat, answer, label)
      })
      if (store.inspect(executionId, fence).state === 'pausing') {
        return { state: store.requestControl(executionId, fence, 'pause') }
      }
      finishWorkingRun(db, executionId, fence, result)
      return { state: 'completed', result }
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause)
      const state = store.inspect(executionId, fence).state
      if (state === 'pausing' || state === 'stopping') {
        const action = state === 'pausing' ? 'pause' : 'stop'
        return { state: store.requestControl(executionId, fence, action), error }
      }
      // A worker may still be live after an ambiguous failure. Keep the checkpoint
      // recoverable and do not mark it failed or allocate a replacement Dispatch.
      return { state: 'recovery_required', error }
    }
  }
}
