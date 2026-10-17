import { graphAvailableSeatCapacity } from './graph/graph-seat-substitution'
import type { ResolvedLocalWorkflowSeat } from '../../../shared/local-workflow-seats'
import type { LocalWorkflowSeatCapacity } from '../../../shared/local-workflow-seat-capacity'
import { runWorkflowPreset } from './workflow-preset-runner'
import { reconcileWorkflowProgram } from './workflow-program-recovery'
import type { AgentSessionProcessIdentity } from '../../../shared/agent-session-record'
import { createWorkflowProgramContext } from './workflow-program-context'
import {
  createDurableWorkflowAgent,
  WorkflowAttemptUnverifiableError,
  WorkflowHostLostError,
  type WorkflowAttemptLaunch
} from './workflow-durable-call'
import type { WorkflowCheckpointStore } from './workflow-checkpoint-store'
import type { WorkflowCheckpointStart } from './workflow-checkpoint-admission'
import { WorkflowScriptSlots } from './workflow-script-slots'
import { createLiveWorkflowAgent, type WorkflowExecutionLiveHooks } from './workflow-execution-live'
import type { NativeResult } from './workflow-native-result'
import { resolveCouncilProgramRevision } from './council-program-revision'
import {
  requireWorkflowFrozenSeat,
  type WorkflowProgramSnapshot
} from './workflow-program-snapshot'
import { GraphWebChangedError } from './graph/graph-web-sources'

export type { WorkflowProgramSnapshot } from './workflow-program-snapshot'
export type WorkflowExecutionOutcome = { state: string; result?: unknown; error?: string }
export type WorkflowNativeAttestationInput = {
  route: ResolvedLocalWorkflowSeat['agent']
  seat: ResolvedLocalWorkflowSeat
  executionId: string
  attemptId: string
  parsed: NativeResult
}
type Active = { abort: AbortController; completion: Promise<WorkflowExecutionOutcome> }

/** One instance per execution host; callers resolve context, accounts and models before Start. */
export class WorkflowExecutionService {
  private readonly active = new Map<string, Active>()
  private readonly completed = new Map<string, WorkflowExecutionOutcome>()

  constructor(
    private readonly options: {
      store: WorkflowCheckpointStore
      slots: WorkflowScriptSlots
      reservation: number
      attemptsPerRun?: number
      attestNativeResult?: (input: WorkflowNativeAttestationInput) => void
      launch: (
        snapshot: WorkflowProgramSnapshot,
        executionId: string,
        fence: number
      ) => WorkflowAttemptLaunch
      progress: (executionId: string, event: { phase?: string; message?: string }) => void
      /** Live view only: slot waits and settlement; never consulted for acceptance. */
      live?: WorkflowExecutionLiveHooks
      /** Account capacity now, for moving a call that failed at launch (graph seat rules). */
      seatCapacity?: () => Promise<(seat: ResolvedLocalWorkflowSeat) => LocalWorkflowSeatCapacity>
    }
  ) {}

  start(
    request: Omit<WorkflowCheckpointStart, 'snapshot'> & { snapshot: WorkflowProgramSnapshot }
  ): string {
    const existing = this.options.store.findStart(request.conversationId, request.requestId)
    const id = this.options.store.create(request)
    if (!existing) {
      this.execute(id, request.fence)
    }
    return id
  }

  isActive(executionId: string): boolean {
    return this.active.has(executionId)
  }

  wait(executionId: string): Promise<WorkflowExecutionOutcome> {
    const active = this.active.get(executionId)
    const completed = this.completed.get(executionId)
    if (active) {
      return active.completion.then((outcome) => structuredClone(outcome))
    }
    if (completed) {
      return Promise.resolve(structuredClone(completed))
    }
    return Promise.reject(new Error('Workflow requires host recovery before waiting'))
  }

  control(executionId: string, fence: number, action: 'pause' | 'stop' | 'finish'): string {
    const state = this.options.store.requestControl(executionId, fence, action)
    if (action === 'stop' && ['stopping', 'cancelled'].includes(state)) {
      this.active.get(executionId)?.abort.abort(new Error('Workflow stopped'))
    }
    return state
  }

  resume(executionId: string, fence: number): void {
    if (this.active.has(executionId)) {
      throw new Error('Workflow is still draining')
    }
    this.options.store.resume(executionId, fence)
    this.execute(executionId, fence)
  }

  recoverCompleted(executionId: string, fence: number): Promise<WorkflowExecutionOutcome> {
    if (this.active.has(executionId)) {
      throw new Error('Workflow is still active')
    }
    if (this.options.store.inspect(executionId, fence).state !== 'completed') {
      throw new Error('Only completed workflows can replay without process reconciliation')
    }
    this.execute(executionId, fence, true)
    return this.wait(executionId)
  }

  recoverInterrupted(
    executionId: string,
    fence: number,
    owner: AgentSessionProcessIdentity
  ): Promise<WorkflowExecutionOutcome & { fence: number }> {
    if (this.active.has(executionId)) {
      throw new Error('Workflow is still active')
    }
    const abort = new AbortController()
    const completion = (async () => {
      const claimedFence = await this.options.store.claimOwner(executionId, fence, owner)
      const outcome = await reconcileWorkflowProgram({
        store: this.options.store,
        slots: this.options.slots,
        executionId,
        fence: claimedFence,
        attestNativeResult:
          this.options.attestNativeResult ??
          (() => {
            throw new Error('Workflow native attestation is unavailable during recovery')
          })
      })
      return { ...outcome, fence: claimedFence }
    })()
      .then((outcome) => {
        this.completed.set(executionId, structuredClone(outcome))
        return outcome
      })
      .finally(() => this.active.delete(executionId))
    this.completed.delete(executionId)
    this.active.set(executionId, { abort, completion })
    return completion
  }

  private execute(executionId: string, fence: number, replayOnly = false): void {
    const abort = new AbortController()
    const run = async (): Promise<WorkflowExecutionOutcome> => {
      const { store } = this.options
      try {
        const frozen = store.inspect(executionId, fence)
        const snapshot = frozen.snapshot as WorkflowProgramSnapshot
        if (snapshot.version !== 1) {
          throw new Error('Unsupported workflow program snapshot')
        }
        const seat = (id: string) => requireWorkflowFrozenSeat(snapshot, id)
        const concurrency = snapshot.limits?.concurrency ?? this.options.slots.limit
        if (
          !Number.isInteger(concurrency) ||
          concurrency < 1 ||
          concurrency > this.options.slots.limit
        ) {
          throw new Error('Invalid frozen workflow concurrency')
        }
        const localSlots = new WorkflowScriptSlots(concurrency)
        const slots = (onAcquired?: () => void): Pick<WorkflowScriptSlots, 'run'> => ({
          run: (work, signal) =>
            localSlots.run(
              () =>
                this.options.slots.run(() => {
                  onAcquired?.()
                  return work()
                }, signal),
              signal
            )
        })
        const durable: Omit<Parameters<typeof createDurableWorkflowAgent>[0], 'slots'> = {
          store,
          executionId,
          fence,
          seatFailures: new Map(),
          signal: abort.signal,
          reservation: this.options.reservation,
          attemptsPerRun: this.options.attemptsPerRun,
          attestNativeResult: this.options.attestNativeResult
            ? ({ call, attemptId, parsed }) =>
                this.options.attestNativeResult!({
                  route: seat(call.seatId).agent,
                  seat: seat(call.seatId),
                  executionId,
                  attemptId,
                  parsed
                })
            : undefined,
          seatFingerprint: (id) => JSON.stringify(seat(id)),
          route: (id) => seat(id).agent,
          launch: replayOnly
            ? async () => {
                throw new Error('Completed workflow recovery cannot launch a model')
              }
            : this.options.launch(snapshot, executionId, fence),
          closeAdmission: (error) => {
            // A lost host fails the run by name: no stop request, which would read as cancelled.
            if (error instanceof WorkflowHostLostError) {
              abort.abort(error)
              return
            }
            try {
              store.requestControl(executionId, fence, 'stop')
            } finally {
              abort.abort(error)
            }
          }
        }
        const agent = createLiveWorkflowAgent({
          executionId,
          live: replayOnly ? undefined : this.options.live,
          slots,
          create: (callSlots) => createDurableWorkflowAgent({ ...durable, slots: callSlots })
        })
        const context = createWorkflowProgramContext({
          agent,
          guard: () => {
            abort.signal.throwIfAborted()
            if (
              store.inspect(executionId, fence).state !== (replayOnly ? 'completed' : 'running')
            ) {
              throw new Error('Workflow admission paused')
            }
          },
          isFatal: (error) =>
            error instanceof WorkflowAttemptUnverifiableError || abort.signal.aborted,
          phase: (phase) => {
            if (!replayOnly) {
              this.options.progress(executionId, { phase })
            }
          },
          log: (message) => {
            if (!replayOnly) {
              this.options.progress(executionId, { message })
            }
          }
        })
        const programSnapshot =
          frozen.preset === 'council' && snapshot.graphProgramRevision === undefined
            ? {
                ...snapshot,
                councilProgramRevision: await resolveCouncilProgramRevision(
                  store,
                  executionId,
                  fence,
                  snapshot
                )
              }
            : snapshot
        const result = await runWorkflowPreset(context, frozen.preset, programSnapshot, undefined, {
          jev: { executionId, cacheOnly: replayOnly },
          refused: (callId) => store.attempts.graphCallRefused(executionId, fence, callId),
          recorded: () => store.readCallEvidence(executionId, fence).map((row) => row.callId),
          webStarts: store.attempts.webStarts(executionId, fence),
          ...(this.options.seatCapacity
            ? {
                seatCapacity: graphAvailableSeatCapacity(
                  this.options.seatCapacity,
                  durable.seatFailures!
                )
              }
            : {}),
          processes: { signal: abort.signal, slot: (work) => slots().run(work, abort.signal) }
        })
        const state = store.finish(executionId, fence, true)
        return { state, ...(state === 'completed' ? { result } : {}) }
      } catch (cause) {
        if (replayOnly) {
          try {
            store.blockCompletedRecovery(executionId, fence)
          } catch {
            /* A corrupt checkpoint may have already blocked recovery. */
          }
          return {
            state: 'recovery_required',
            error: cause instanceof Error ? cause.message : String(cause)
          }
        }
        // Kept pages that changed or went missing are damage for a person to recover, never a failure.
        if (cause instanceof GraphWebChangedError) {
          return { state: 'recovery_required', error: cause.message }
        }
        let state: string
        try {
          state = store.finish(executionId, fence, false)
        } catch {
          state = 'recovery_required'
        }
        return {
          state,
          ...(['failed', 'recovery_required'].includes(state)
            ? { error: cause instanceof Error ? cause.message : String(cause) }
            : {})
        }
      }
    }
    const completion = run().then((outcome) => {
      this.completed.set(executionId, structuredClone(outcome))
      this.active.delete(executionId)
      return outcome
    })
    this.completed.delete(executionId)
    this.active.set(executionId, { abort, completion })
  }
}
