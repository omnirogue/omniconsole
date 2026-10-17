import { isLiveSessionChain, type SessionChain } from '../../../shared/session-chain-types'
import { sessionRunRowState } from './session-run-row-state'

/**
 * Whether anything is still queued after the chain's row. A sealed, failed or cancelled run is
 * history: it is still shown, and it queues nothing, so no closed row reads "N sessions queued".
 * A queue without outcomes keeps its old rule: live, or failed until the person dismisses it.
 */
export function isQueuedSessionChain(chain: SessionChain, now = Date.now()): boolean {
  if (chain.outcomeSet) {
    return !sessionRunRowState(chain, { now }).settled
  }
  return isLiveSessionChain(chain) || chain.state === 'failed'
}

/**
 * The one chain a row speaks for, however many were ever queued after it: the unfinished one,
 * else the newest. Every lookup keyed by row picks through here, so no two can disagree.
 */
export function preferredSessionChain(
  chains: readonly SessionChain[],
  now = Date.now()
): SessionChain | null {
  let best: { chain: SessionChain; open: boolean } | null = null
  for (const chain of chains) {
    const open = chain.outcomeSet ? isQueuedSessionChain(chain, now) : isLiveSessionChain(chain)
    if (
      !best ||
      (open && !best.open) ||
      (open === best.open && chain.createdAt >= best.chain.createdAt)
    ) {
      best = { chain, open }
    }
  }
  return best?.chain ?? null
}
