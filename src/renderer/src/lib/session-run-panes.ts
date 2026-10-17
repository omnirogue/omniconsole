import type { SessionChain } from '../../../shared/session-chain-types'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { sessionRunRowState } from './session-run-row-state'

/** How a pane belongs to a pursued run: one of its workers, the conversation it started from, or neither. */
export function sessionRunPaneRole(
  chain: SessionChain,
  pane: { paneKey: string; tabId?: string }
): 'worker' | 'source' | null {
  if (!chain.outcomeSet) {
    return null
  }
  const tabId = pane.tabId ?? parsePaneKey(pane.paneKey)?.tabId
  const worker =
    chain.steps.some((step) => step.kind !== 'handoff' && step.launchedPaneKey === pane.paneKey) ||
    chain.outcomeSet.attempts.some(
      (attempt) => attempt.taskId !== undefined && `worker-${attempt.taskId}` === tabId
    )
  if (worker) {
    return 'worker'
  }
  return pane.paneKey === chain.sourcePaneKey ? 'source' : null
}

/**
 * Whether a run this pane works for already carries an open request for its owner. The host
 * announces a request once (`notifiedAt`), so the pane's own "needs input" must not ring again.
 */
export function sessionRunAsksThroughPane(
  chains: readonly SessionChain[],
  paneKey: string,
  now: number
): boolean {
  return chains.some(
    (chain) =>
      sessionRunPaneRole(chain, { paneKey }) !== null &&
      sessionRunRowState(chain, { now }).requests.length > 0
  )
}
