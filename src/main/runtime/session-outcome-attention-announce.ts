import type { SessionChain } from '../../shared/session-chain-types'
import type { HumanAttentionRequest } from '../../shared/session-human-attention'
import { getRuntimeDesktopSurface } from './runtime-desktop-surface'

/** Tells the owner about requests the host has just stamped as announced. Best-effort by contract. */
export type SessionAttentionAnnouncer = (
  chain: SessionChain,
  requests: readonly HumanAttentionRequest[]
) => void

/**
 * The desktop's own notification surface; a host with no desktop shows nothing and the request
 * stays readable as Needs You. Both lines are the run's own words — what the work is, and exactly
 * what is asked — so no copy is invented here.
 */
export const announceSessionHumanAttention: SessionAttentionAnnouncer = (chain, requests) => {
  for (const request of requests) {
    const outcome = chain.outcomeSet?.outcomes.find((entry) => entry.id === request.scope.outcomeId)
    getRuntimeDesktopSurface().showNotification({
      title: outcome?.title ?? request.ask,
      body: request.ask
    })
  }
}
