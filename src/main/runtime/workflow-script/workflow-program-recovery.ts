import { WorkflowCacheMissError } from './workflow-cache-miss'
import { auditReplayPortsForExecution } from './audit/audit-host'
import type { WorkflowCheckpointStore } from './workflow-checkpoint-store'
import type { WorkflowScriptSlots } from './workflow-script-slots'
import type {
  WorkflowNativeAttestationInput,
  WorkflowExecutionOutcome,
  WorkflowProgramSnapshot
} from './workflow-execution-service'
import { createDurableWorkflowAgent } from './workflow-durable-call'
import { workflowFrozenSeat } from './workflow-program-snapshot'
import { createWorkflowProgramContext } from './workflow-program-context'
import { runWorkflowPreset } from './workflow-preset-runner'
import { graphJevJudgeForExecution } from './graph/graph-jev'
import { graphCheckerForExecution } from './graph/graph-check'
import { graphJevScreenerForExecution } from './graph/graph-jev-screen'
import { graphJevRouterForExecution } from './graph/graph-jev-route'
import { graphGitHubFactsForExecution } from './graph/graph-github-facts'
import { graphGitHubHarvestForExecution } from './graph/graph-github-harvest'
import { graphEvidenceCheckerForExecution } from './graph/graph-evidence-checker'
import { graphJevVerifierForExecution } from './graph/graph-jev-verify'
import {
  GraphWebChangedError,
  graphWebForExecution,
  graphWebReadersStarted
} from './graph/graph-web-sources'
import type { GraphCall, GraphOutcome } from './graph/graph-plan-types'
import { resolveCouncilProgramRevision } from './council-program-revision'
import {
  settleInterruptedWorkflowAttempts,
  workflowInterruptedNote,
  type WorkflowInterruptedProcessProbe,
  type WorkflowInterruptedSettlement
} from './workflow-interrupted-attempts'

/** Reconstructs validators from bundled code. It cannot construct a provider or prepare new work. */
export async function reconcileWorkflowProgram(input: {
  store: WorkflowCheckpointStore
  slots: WorkflowScriptSlots
  executionId: string
  fence: number
  attestNativeResult: (input: WorkflowNativeAttestationInput) => void
  /** Tests only; the host's process table otherwise. */
  processes?: WorkflowInterruptedProcessProbe
}): Promise<WorkflowExecutionOutcome> {
  const { store, executionId, fence } = input
  const errors: string[] = []
  const missing = new Set<string>()
  const failed: string[] = []
  let interrupted: WorkflowInterruptedSettlement = { settled: [], unresolved: new Map() }
  let result: unknown
  try {
    const frozen = store.inspect(executionId, fence)
    if (!['paused', 'pausing', 'stopping', 'cancelled'].includes(frozen.state)) {
      throw new Error('Workflow must be closed for reconciliation')
    }
    // Agents the dead owner never saw exit are settled first, whichever call the replay reaches.
    interrupted = await settleInterruptedWorkflowAttempts({
      store,
      executionId,
      fence,
      probe: input.processes
    })
    const snapshot = frozen.snapshot as WorkflowProgramSnapshot
    const seat = (id: string) => {
      const seat = workflowFrozenSeat(snapshot, id)
      if (!seat) {
        throw new Error('Missing frozen workflow seat')
      }
      return seat
    }
    const cached = createDurableWorkflowAgent({
      store,
      slots: input.slots,
      executionId,
      fence,
      signal: new AbortController().signal,
      reservation: 0,
      cacheOnly: true,
      seatFingerprint: (id) => JSON.stringify(seat(id)),
      route: (id) => seat(id).agent,
      closeAdmission: () => {},
      launch: async () => {
        throw new Error('Reconciliation cannot launch a provider')
      }
    })
    const context = createWorkflowProgramContext({
      agent: async (call) => {
        const pending = store
          .pendingAttempts(executionId, fence)
          .filter((attempt) => attempt.call_id === call.id)
        if (pending.length > 1) {
          throw new Error('Multiple unresolved attempts require manual recovery')
        }
        if (pending[0]) {
          const reason = interrupted.unresolved.get(pending[0].id)
          if (reason) {
            errors.push(`${call.id}: ${reason}`)
            throw new Error(reason)
          }
          try {
            if (
              store.recoverAttempt({
                attemptId: pending[0].id,
                fence,
                call,
                attestNativeResult: input.attestNativeResult
              }) === 'failed'
            ) {
              failed.push(`${call.id}: recovered output failed validation`)
            }
          } catch (error) {
            errors.push(`${call.id}: ${error instanceof Error ? error.message : String(error)}`)
            throw error
          }
        }
        try {
          return await cached(call)
        } catch (error) {
          if (error instanceof WorkflowCacheMissError) {
            missing.add(call.id)
          } else {
            errors.push(`${call.id}: ${error instanceof Error ? error.message : String(error)}`)
          }
          throw error
        }
      },
      guard: () => {
        const state = store.inspect(executionId, fence).state
        if (!['paused', 'pausing', 'stopping', 'cancelled'].includes(state)) {
          throw new Error('Workflow reconciliation state changed')
        }
      },
      phase: () => {},
      log: () => {},
      isFatal: () => false
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
    const replayJev = graphJevJudgeForExecution(executionId, { cacheOnly: true })
    const replayCheck = graphCheckerForExecution(executionId, { cacheOnly: true })
    const replayScreen = graphJevScreenerForExecution(executionId, { cacheOnly: true })
    const replayRoute = graphJevRouterForExecution(executionId, { cacheOnly: true })
    const replayFacts = graphGitHubFactsForExecution(executionId, { cacheOnly: true })
    const replayHarvest = graphGitHubHarvestForExecution(executionId, { cacheOnly: true })
    const replayEvidence = graphEvidenceCheckerForExecution(executionId, { cacheOnly: true })
    const replayVerify = graphJevVerifierForExecution(executionId, { cacheOnly: true })
    const replayWeb = graphWebForExecution(executionId, {
      cacheOnly: true,
      starts: store.attempts.webStarts(executionId, fence),
      ...graphWebReadersStarted(snapshot, () =>
        store.readCallEvidence(executionId, fence).map((row) => row.callId)
      )
    })
    // A ballot or check not yet recorded is a call still to make, like any cache miss here.
    const replay =
      (answer: (call: GraphCall) => Promise<GraphOutcome>) =>
      async (call: GraphCall): Promise<GraphOutcome> => {
        try {
          return await answer(call)
        } catch (error) {
          // A kept page that changed is damage to report, never a call still to make.
          if (error instanceof GraphWebChangedError) {
            errors.push(`${call.id}: ${error.message}`)
          } else {
            missing.add(call.id)
          }
          throw error
        }
      }
    result = await runWorkflowPreset(context, frozen.preset, programSnapshot, undefined, {
      ...(snapshot.audit
        ? { audit: auditReplayPortsForExecution(snapshot.audit, executionId, missing, errors) }
        : {}),
      refused: (callId) => store.attempts.graphCallRefused(executionId, fence, callId),
      // Seat rules: a recorded substitute replays as the call it stood in for.
      recorded: () => store.readCallEvidence(executionId, fence).map((row) => row.callId),
      judgeWithJev: replay(replayJev),
      screenWithJev: replay(replayScreen),
      routeWithJev: replay(replayRoute),
      fetchFacts: replay(replayFacts),
      harvestGitHub: replay(replayHarvest),
      checkEvidence: replay(replayEvidence),
      verifyWithJev: replay(replayVerify),
      readWeb: replay(replayWeb),
      checkCandidate: replay(replayCheck)
    })
  } catch (error) {
    if (!errors.length && !missing.size) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  try {
    const state = store.inspect(executionId, fence).state
    const pending = store.pendingAttempts(executionId, fence)
    if (pending.length) {
      const reasons = pending.flatMap((attempt) => {
        const reason = interrupted.unresolved.get(attempt.id)
        return reason ? [`${attempt.call_id}: ${reason}`] : []
      })
      return {
        state: 'recovery_required',
        error: errors.join('; ') || reasons.join('; ') || 'Unresolved workflow attempts remain'
      }
    }
    if (errors.length) {
      return { state: 'recovery_required', error: errors.join('; ') }
    }
    const notes = [
      ...failed,
      ...(state === 'paused' && interrupted.settled.length
        ? [workflowInterruptedNote(interrupted.settled.length)]
        : [])
    ]
    return {
      state,
      ...(notes.length ? { error: notes.join('; ') } : {}),
      ...(result !== undefined ? { result } : {})
    }
  } catch (error) {
    return {
      state: 'recovery_required',
      error: [...errors, error instanceof Error ? error.message : String(error)].join('; ')
    }
  }
}
