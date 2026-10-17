import type { AgentStatusState } from '../../../../shared/agent-status-types'
import type { NextStepOutcomeDraft } from '../../../../shared/next-step-draft'
import { outcomeDraftProgress } from '../../../../shared/next-outcome-draft-progress'
import type { SessionChain } from '../../../../shared/session-chain-types'
import { openHumanAttentionRequests } from '../../../../shared/session-human-attention'
import { effectiveSessionOutcomeBlock } from '../../../../shared/session-outcome-block'
import type {
  SessionOutcome,
  SessionOutcomeCondition
} from '../../../../shared/session-outcome-types'

/** One line about where the session stands, from facts the app already holds. */
export type NextStepSessionPhase =
  | 'complete'
  | 'needs-you'
  | 'failed'
  | 'recovering'
  | 'returned'
  | 'waiting'
  | 'working'
  | 'done'
  | 'idle'

export type NextStepPhaseInput = {
  /** The pane's hook-reported state; null when no pane or no report yet. */
  agentState: AgentStatusState | null
  /** A plan ended with ↩ Back to me since the pane last changed state. */
  returned: boolean
  outcome: Pick<NextStepOutcomeDraft, 'status' | 'needsYouReason'> &
    Partial<Pick<NextStepOutcomeDraft, 'id' | 'revision'>>
  /** Host progress may advance while editable draft fields remain unsaved. */
  chain?: Pick<SessionChain, 'outcomeSet' | 'planVersion'> | null
  /** The clock a stale recovery is judged against; a test passes its own. */
  now?: number
}

export type NextStepPhaseReading = {
  phase: NextStepSessionPhase
  /** What the person reads beside the phase: only ever what an open request ASKS of them. */
  reason: string | null
  /** The host's raw reason for a stop: a diagnostic for a tooltip, never the headline. */
  diagnostic?: string
  /** What a waiting outcome waits for, when the host named it. */
  wake?: string
}

/**
 * A blocked outcome, read by the class its writer gave it (`session-outcome-block.ts`). It is
 * never "needs you": that comes only from an open request, which the caller has already ruled out.
 */
function blockedPhase(
  chain: Pick<SessionChain, 'outcomeSet' | 'planVersion'>,
  saved: SessionOutcome,
  now: number
): NextStepPhaseReading | null {
  const block = effectiveSessionOutcomeBlock(saved, now)
  if (!block) {
    return null
  }
  const diagnostic = saved.blockedReason ? { diagnostic: saved.blockedReason } : {}
  if (block.class === 'failed') {
    return { phase: 'failed', reason: null, ...diagnostic }
  }
  if (block.class === 'recovering') {
    return { phase: 'recovering', reason: null, ...diagnostic }
  }
  // An `attention` block here has no request to the owner: either someone else was asked, or the
  // request is gone and the host re-derives it on its next pass.
  const others = openHumanAttentionRequests(chain.outcomeSet!, chain.planVersion ?? 1).filter(
    (request) => request.scope.outcomeId === saved.id && request.recipient.type === 'person'
  )
  if (block.class === 'attention' && !others.length) {
    return { phase: 'recovering', reason: null, ...diagnostic }
  }
  const person = others[0]?.recipient
  const wake = block.wake ?? (person?.type === 'person' ? (person.name ?? person.employeeId) : '')
  return { phase: 'waiting', reason: null, ...diagnostic, ...(wake ? { wake } : {}) }
}

/**
 * A saved outcome speaks first (it is what the person committed to), then a plan handing
 * the row back, then the pane's own state. Nothing here claims more than a stored fact.
 */
export function nextStepSessionPhase(input: NextStepPhaseInput): NextStepPhaseReading {
  const { id, revision } = input.outcome
  // Only a saved draft can borrow host progress: an unsaved draft carries no revision, and
  // `undefined === undefined` would otherwise match a stranger and speak for it.
  const saved =
    id !== undefined && revision !== undefined
      ? input.chain?.outcomeSet?.outcomes.find(
          (outcome) => outcome.id === id && outcome.revision === revision
        )
      : undefined
  const now = input.now ?? Date.now()
  const outcome = saved
    ? outcomeDraftProgress(saved, input.chain?.outcomeSet, input.chain?.planVersion ?? 1, now)
    : input.outcome
  switch (outcome.status) {
    case 'needs-you':
      return { phase: 'needs-you', reason: outcome.needsYouReason ?? null }
    case 'complete':
      return { phase: 'complete', reason: null }
    case 'failed':
    case 'recovering':
      // A saved outcome's block says more (its diagnostic, its wake); a draft has only the status.
      if (!saved) {
        return { phase: outcome.status, reason: null }
      }
      break
    case 'waiting':
    case 'pending':
    case undefined:
      break
  }
  const blocked = saved && input.chain ? blockedPhase(input.chain, saved, now) : null
  if (blocked) {
    return blocked
  }
  if (input.returned) {
    return { phase: 'returned', reason: null }
  }
  if (outcome.status === 'waiting') {
    return { phase: 'waiting', reason: null }
  }
  switch (input.agentState) {
    case 'working':
      return { phase: 'working', reason: null }
    // The agent's OWN prompt — a question, a permission — which only its person can answer.
    case 'blocked':
    case 'waiting':
      return { phase: 'needs-you', reason: null }
    case 'done':
      return { phase: 'done', reason: null }
    case null:
      return { phase: 'idle', reason: null }
  }
}

export type NextStepVerificationItem = {
  outcomeId: string
  outcomeTitle: string
  conditionId: string
  kind: SessionOutcomeCondition['kind']
  target: string
  verified: boolean
}

export type NextStepVerification = {
  verified: number
  total: number
  items: NextStepVerificationItem[]
}

/** "n/m verified": conditions with host evidence over every condition the saved outcomes carry. */
export function outcomeVerification(
  chain: Pick<SessionChain, 'outcomeSet'> | null | undefined
): NextStepVerification | null {
  const set = chain?.outcomeSet
  if (!set) {
    return null
  }
  const items = set.outcomes.flatMap((outcome) =>
    outcome.conditions.map((condition) => ({
      outcomeId: outcome.id,
      outcomeTitle: outcome.title,
      conditionId: condition.id,
      kind: condition.kind,
      target: condition.target,
      verified: outcome.evidence.some((evidence) => evidence.conditionId === condition.id)
    }))
  )
  return {
    verified: items.filter((item) => item.verified).length,
    total: items.length,
    items
  }
}
