import { CONVERSATION_ARCHIVED_AFTER_MS } from './conversation-retention-window'
import {
  isSessionChainAgentStep,
  isSessionFollowUpChain,
  sessionFollowUpStep,
  type SessionChain
} from './session-chain-types'
const FOLLOW_UP_RECORD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** Keep failed work visible and retain launched-pane provenance for subsequent file handoffs. */
export function shouldKeepSessionChainRecord(chain: SessionChain, now: number): boolean {
  if (chain.outcomeSet) {
    return true
  }
  if (chain.state === 'failed') {
    return true
  }
  // Why: the row reads its plan to say "Handed to X" and to stay in Completed; pruning the record
  // on the next restart moved a finished conversation back into the active list.
  if (chain.state === 'done' && now - chain.updatedAt < CONVERSATION_ARCHIVED_AFTER_MS) {
    return true
  }
  if (chain.steps.some((step) => isSessionChainAgentStep(step) && step.launchedPaneKey)) {
    return true
  }
  return isSessionFollowUpChain(chain) && now - chain.updatedAt < FOLLOW_UP_RECORD_RETENTION_MS
}

/** A follow-up stopped only because its host or its run could not be verified resumes on load. */
export function isHostWaitingFollowUp(chain: SessionChain): boolean {
  const code = sessionFollowUpStep(chain)?.handoff.exception?.code
  return chain.state === 'failed' && (code === 'host-unreachable' || code === 'unverifiable')
}
