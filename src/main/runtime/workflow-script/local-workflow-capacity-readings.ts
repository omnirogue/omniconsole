import type { ProviderAccountCapacitySnapshot } from '../../../shared/provider-account-capacity'
import type { ResolvedLocalWorkflowSeat } from '../../../shared/local-workflow-seats'
import {
  workflowSeatCapacity,
  type LocalWorkflowSeatCapacity
} from '../../../shared/local-workflow-seat-capacity'
import type { OrcaRuntimeService } from '../omni-runtime'

/** The host's Claude and Codex account rows; undefined where account services are absent. */
export function workflowCapacityRows(
  runtime: OrcaRuntimeService
): ProviderAccountCapacitySnapshot | undefined {
  try {
    return runtime.getAccountsSnapshot().rateLimits.accountCapacity
  } catch {
    return undefined
  }
}

/**
 * Brings stale account readings up to date before seats are chosen, waiting at most `waitMs`:
 * a reading that does not arrive in time leaves that account unverified, never assumed free.
 */
export async function refreshWorkflowCapacity(
  runtime: OrcaRuntimeService,
  waitMs = 5_000
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      runtime.refreshAccountsForMobileSubscriber().catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, waitMs)
        timer.unref?.()
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Every seat's account capacity as of now, after freshening stale readings (bounded). */
export async function workflowSeatCapacityNow(
  runtime: OrcaRuntimeService
): Promise<(seat: ResolvedLocalWorkflowSeat) => LocalWorkflowSeatCapacity> {
  await refreshWorkflowCapacity(runtime)
  const rows = workflowCapacityRows(runtime)
  const now = Date.now()
  return (seat) => workflowSeatCapacity(rows, seat.agent, seat.accountId, now)
}
