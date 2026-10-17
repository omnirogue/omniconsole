import type { ConversationSource } from '../../shared/conversation-source'
import type { SessionChain } from '../../shared/session-chain-types'
import { sessionOutcomeProgress } from '../../shared/session-outcome-state'
import {
  sessionOutcomeWaitsSummary,
  type SessionWaitSummaryItem
} from '../../shared/session-outcome-waits-summary'
import type { OrcaRuntimeService } from './omni-runtime'

/**
 * A plan that has not finished owns this conversation's turn. `complete` outcome
 * sets and chains that ended (done/cancelled/failed) hold nothing.
 */
export function isChainBoundToConversation(
  runtime: Pick<OrcaRuntimeService, 'listSessionChains'>,
  source: Pick<ConversationSource, 'paneKey' | 'worktreeId'>
): boolean {
  return runtime
    .listSessionChains()
    .some((chain) => addressesConversation(chain, source) && isChainLive(chain))
}

const WAIT_STATUS_WORDS: Record<Exclude<SessionWaitSummaryItem['status'], 'met'>, string> = {
  pending: 'not yet',
  needs_you: 'needs your choice',
  unavailable: 'follow-up not scheduled'
}

/** What this conversation's live plan still waits on, one line per wait (`omni session list`). */
export function conversationPlanWaits(
  chains: readonly SessionChain[],
  source: ConversationSource,
  now = Date.now()
): string[] {
  const chain = chains.find((entry) => addressesConversation(entry, source) && isChainLive(entry))
  if (!chain) {
    return []
  }
  return sessionOutcomeWaitsSummary(chain, now).flatMap((wait) =>
    wait.status === 'met'
      ? []
      : [`${wait.label} (${WAIT_STATUS_WORDS[wait.status]}, checked ${wait.checked_at})`]
  )
}

export function addressesConversation(
  chain: SessionChain,
  source: Pick<ConversationSource, 'paneKey' | 'worktreeId'>
): boolean {
  return (
    chain.sourcePaneKey === source.paneKey &&
    (chain.sourceWorktreeId ?? chain.worktreeId) === source.worktreeId
  )
}

function isChainLive(chain: SessionChain): boolean {
  if (chain.state === 'done' || chain.state === 'cancelled' || chain.state === 'failed') {
    return false
  }
  return chain.outcomeSet
    ? sessionOutcomeProgress(chain.outcomeSet).lifecycle !== 'complete'
    : chain.steps.length > chain.currentIndex
}
