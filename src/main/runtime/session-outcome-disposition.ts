import type { SessionChain } from '../../shared/session-chain-types'
import {
  recordSessionRunDisposition,
  retrySessionRunDisposition,
  type SessionRunDispositionReport
} from '../../shared/session-run-completion'

type DispositionLane = {
  get(chainId: string): SessionChain
  save(chain: SessionChain, expectedRevision: number): SessionChain
}

/**
 * Record what a window reported about closing or saving a finished session. Call it inside the
 * chain's lane. Nothing here can reach the seal: an unsealed run has no disposition to report on,
 * a failure leaves the work completed, and no report reopens the execution.
 */
export function reportSessionOutcomeDisposition(
  lane: DispositionLane,
  chainId: string,
  report: SessionRunDispositionReport,
  now: number
): SessionChain {
  const chain = lane.get(chainId)
  const set = chain.outcomeSet!
  const disposition = set.disposition
  if (!set.completion || !disposition) {
    return chain
  }
  // One failure per due window: a second window, or a repeat, must not burn the bounded retries.
  if (!report.ok && disposition.state === 'pending' && (disposition.nextAttemptAt ?? 0) > now) {
    return chain
  }
  const recorded = recordSessionRunDisposition(set, report, now)
  return recorded === set ? chain : lane.save({ ...chain, outcomeSet: recorded }, set.revision)
}

/** The person asked again after the retries ran out: one more bounded series, same operation. */
export function retrySessionOutcomeDisposition(
  lane: DispositionLane,
  chainId: string,
  now: number
): SessionChain {
  const chain = lane.get(chainId)
  const set = chain.outcomeSet!
  const retried = retrySessionRunDisposition(set, now)
  return retried === set ? chain : lane.save({ ...chain, outcomeSet: retried }, set.revision)
}
