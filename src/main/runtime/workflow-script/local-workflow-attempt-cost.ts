import type { LocalWorkflowCallCost } from '../../../shared/local-workflow-view'
import type { ResolvedLocalWorkflowSeat } from '../../../shared/local-workflow-seats'
import type { LocalWorkflowAttemptRecord } from './local-workflow-call-projection'
import { localWorkflowCallCost } from './local-workflow-usage'

/** A call's full known bill, retaining missing launched-attempt prices as partial. */
export function localWorkflowAttemptCost(
  attempts: readonly LocalWorkflowAttemptRecord[],
  seat: Pick<ResolvedLocalWorkflowSeat, 'agent' | 'model'>,
  reported: (attempt: LocalWorkflowAttemptRecord) => number | undefined
): LocalWorkflowCallCost | undefined {
  const terminal = attempts.filter((attempt) =>
    ['accepted', 'failed', 'cancelled'].includes(attempt.state)
  )
  const prices = terminal.flatMap((attempt) => {
    const receipt = attempt.receipt_json ? JSON.parse(attempt.receipt_json) : undefined
    if (receipt?.noLaunch === true) {
      return []
    }
    return [localWorkflowCallCost(seat, receipt, reported(attempt))]
  })
  const known = prices.flatMap((price) => (price ? [price] : []))
  return known.length
    ? {
        usd: known.reduce((sum, price) => sum + price.usd, 0),
        source: known.every((price) => price.source === 'cli') ? 'cli' : 'table',
        ...(known.length < prices.length ? { partial: true as const } : {})
      }
    : undefined
}
