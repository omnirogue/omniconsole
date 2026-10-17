import type { PersistedState } from '../../../shared/persisted-state-types'
import {
  ROUTINE_DELIVERY_UNCONFIRMED,
  type RoutineDeliveryWrite
} from '../../../shared/routine-delivery-state'
import { routineDeliveryPlan } from '../../../shared/routine-delivery-plan'

/** Persist before a side effect. A lost acknowledgement must never authorize a second attempt. */
export async function writeAutomationDelivery(
  state: PersistedState,
  flush: () => Promise<void>,
  input: RoutineDeliveryWrite
) {
  const automation = state.automations.find((row) => row.id === input.automationId)
  const run = state.automationRuns.find(
    (row) => row.id === input.runId && row.automationId === input.automationId
  )
  if (!automation || !run || run.status !== 'completed') {
    throw new Error('Completed routine run not found.')
  }
  const claimed = run.deliveryClaims?.[input.phase]
  if (input.results === undefined && claimed) {
    return { acquired: false, run }
  }
  if (input.results !== undefined && claimed !== input.claimId) {
    throw new Error('Routine delivery claim does not match.')
  }
  const plan = routineDeliveryPlan(automation, run, input.phase)
  const keys = new Set(plan.map((row) => `${row.kind}:${row.target}`))
  if (input.results?.some((row) => !keys.has(`${row.kind}:${row.target}`))) {
    throw new Error('Receipt target is not in the routine definition.')
  }
  const receipts =
    input.results ??
    plan.map(({ kind, target }) => ({
      kind,
      target,
      ok: false,
      error: ROUTINE_DELIVERY_UNCONFIRMED
    }))
  const merged = new Map(
    (run.deliveryResults ?? []).map((row) => [`${row.kind}:${row.target}`, row])
  )
  for (const receipt of receipts) {
    merged.set(`${receipt.kind}:${receipt.target}`, receipt)
  }
  const updated = {
    ...run,
    deliveryClaims: { ...run.deliveryClaims, [input.phase]: input.claimId },
    deliveryResults: [...merged.values()]
  }
  state.automationRuns = state.automationRuns.map((row) => (row.id === run.id ? updated : row))
  // History refreshes by definition revision, including receipts that arrive after completion.
  state.automations = state.automations.map((row) =>
    row.id === automation.id
      ? { ...row, updatedAt: Math.max(Date.now(), (row.updatedAt ?? 0) + 1) }
      : row
  )
  await flush()
  return { acquired: input.results === undefined, run: updated }
}
