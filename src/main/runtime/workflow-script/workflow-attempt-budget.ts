import type { ProcessResult } from '../../../shared/child-process/process-spec'
import type { LocalWorkflowRoute } from '../../../shared/local-workflow-seats'
import { WorkflowBudgetRefusedError, type WorkflowCallBudget } from './workflow-call-budget'

/**
 * One prepared attempt of a budgeted run: admitted by the shared authority before it launches,
 * settled once however it ends. Settlements are best effort: one that never arrives leaves the
 * whole reservation counted until it is reconciled.
 */
export type WorkflowAttemptBudget = {
  grant: { reservedUsd: number }
  launched: (
    result: ProcessResult,
    outcome: 'ok' | 'failed' | 'cancelled',
    usage?: unknown,
    providerRequestId?: string
  ) => Promise<void>
  /** The adapter proved nothing left this computer. */
  notSent: (reason: string) => Promise<void>
  /** Lost or uncertain: the reservation stays. */
  unknown: () => Promise<void>
}

export async function admitWorkflowAttempt(input: {
  budget?: WorkflowCallBudget
  seat?: { model: string; effort?: string | null; accountId?: string }
  attemptId: string
  callId: string
  route: LocalWorkflowRoute
  signal: AbortSignal
  /** Records the attempt as never launched and closes the run's admission. */
  refused: (refusal: WorkflowBudgetRefusedError) => void
}): Promise<WorkflowAttemptBudget | undefined> {
  const { budget, attemptId, route } = input
  if (!budget) {
    return undefined
  }
  let grant: { reservedUsd: number }
  try {
    grant = await budget.admit({
      attemptId,
      callId: input.callId,
      route,
      model: input.seat?.model ?? 'unknown',
      ...(input.seat?.effort ? { effort: input.seat.effort } : {}),
      ...(input.seat?.accountId ? { accountRef: input.seat.accountId } : {}),
      signal: input.signal
    })
  } catch (cause) {
    const refusal =
      cause instanceof WorkflowBudgetRefusedError
        ? cause
        : new WorkflowBudgetRefusedError('admission_interrupted')
    // Refused before launch: no provider request is ever made for this attempt.
    input.refused(refusal)
    throw refusal
  }
  const quietly = (work: () => Promise<void>) => work().catch(() => undefined)
  return {
    grant,
    launched: (result, outcome, usage, providerRequestId) =>
      quietly(() =>
        budget.settleProcess({
          attemptId,
          route,
          stdout: result.stdout,
          outcome,
          ...(usage === undefined ? {} : { usage }),
          ...(providerRequestId ? { providerRequestId } : {})
        })
      ),
    notSent: (reason) => quietly(() => budget.notSent(attemptId, reason)),
    unknown: () => quietly(() => budget.unknown(attemptId))
  }
}
