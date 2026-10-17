/**
 * What the host knows about one stage's SEAT from outside the seat's own record: the
 * conversation its worker is running in, and the prompts it is holding while another writer
 * saves the chain around it.
 *
 * Both exist because two different owners write one step. The renderer launcher records the
 * pane it opened (`launchedPaneKey`); the host executor never does — it records a Dispatch —
 * so a host-launched seat has to be joined to its worker pane through that Dispatch, or
 * every prompt the person added under an Agent block waits forever for a pane key nobody
 * writes. And the tick saves the whole chain from a snapshot it took before its awaits, so a
 * prompt admitted, delivered or withdrawn meanwhile has to be carried into that save.
 */

import type { ConversationSource } from '../../shared/conversation-source'
import {
  isSessionChainAgentStep,
  type SessionChain,
  type SessionChainAgentStep
} from '../../shared/session-chain-types'
import { sessionOutcomeStepActionId } from '../../shared/session-outcome-identity'
import type { OrcaRuntimeService } from './omni-runtime'

/** The attempt this seat is running under; a retryable or superseded one is not it. */
function seatAttempt(chain: SessionChain, step: SessionChainAgentStep) {
  return (chain.outcomeSet?.attempts ?? []).findLast(
    (attempt) =>
      attempt.actionId === sessionOutcomeStepActionId(step.id) &&
      attempt.state !== 'retryable' &&
      attempt.state !== 'superseded'
  )
}

/** The worker pane this seat's Dispatch was assigned, as the orchestration db recorded it. */
function dispatchedPaneKey(
  runtime: OrcaRuntimeService,
  chain: SessionChain,
  step: SessionChainAgentStep
): string | null {
  const attempt = seatAttempt(chain, step)
  if (!attempt?.dispatchId && !attempt?.taskId) {
    return null
  }
  try {
    const db = runtime.getOrchestrationDb()
    const dispatch = attempt.dispatchId
      ? db.getDispatchContextById(attempt.dispatchId)
      : db.getDispatchContext(attempt.taskId!)
    return dispatch?.assignee_pane_key ?? null
  } catch {
    // No orchestration db on this host: there is no worker pane to read, and that is not
    // an error — a seat with no worker simply keeps holding its prompts.
    return null
  }
}

/** The seat's own conversation: the pane its worker owns, whoever launched it. */
export function upNextSeatConversation(
  runtime: OrcaRuntimeService,
  chain: SessionChain,
  step: SessionChainAgentStep
): ConversationSource | null {
  const paneKey = step.launchedPaneKey ?? dispatchedPaneKey(runtime, chain, step)
  return paneKey ? { worktreeId: chain.worktreeId, paneKey, kind: 'pty' } : null
}

/**
 * The pane each host-launched seat is really running in, written onto its step ONCE.
 *
 * `launchedPaneKey` is how three readers join a pane to the step it IS — the session-activity
 * row (`session-activity-step.ts`), the team summary and the chain registry — and only the
 * RENDERER launcher ever wrote it. A seat the host launched carries a Dispatch instead, so for
 * every outcome-bound seat those three readers had nothing to join and showed nothing at all.
 * The join the host already makes read-only above is persisted here, on the tick's own
 * whole-chain save, because the pane does not exist at launch: the Dispatch is assigned one
 * later. Never overwritten — the launcher stays the author of the panes it opened — and never
 * guessed: a seat whose Dispatch has no pane keeps nothing, and is asked again next tick.
 */
export function upNextStampedSeatPanes(
  runtime: OrcaRuntimeService,
  chain: SessionChain
): SessionChain {
  let stamped = false
  const steps = chain.steps.map((step) => {
    if (!isSessionChainAgentStep(step) || step.launchedPaneKey) {
      return step
    }
    const paneKey = dispatchedPaneKey(runtime, chain, step)
    if (!paneKey) {
      return step
    }
    stamped = true
    return { ...step, launchedPaneKey: paneKey }
  })
  return stamped ? { ...chain, steps } : chain
}

/**
 * The chain a whole-chain save is about to write, with every seat's prompts taken from the
 * record as it stands NOW.
 *
 * The tick owns status, waits and attempts; it never owns prompts. Its snapshot is minutes
 * old by the time the save lands, so writing that copy back rolled a delivered prompt to
 * `queued` (it was then sent twice), resurrected a row the person took back, and dropped one
 * just attached. Carrying the live prompts is what makes both writers true at once.
 */
export function upNextCarriedStagePrompts(
  runtime: OrcaRuntimeService,
  chain: SessionChain
): SessionChain {
  const fresh = runtime.listSessionChains().find((entry) => entry.id === chain.id)
  if (!fresh) {
    return chain
  }
  let carried = false
  const steps = chain.steps.map((step) => {
    const live = fresh.steps.find((entry) => entry.id === step.id)
    if (!isSessionChainAgentStep(step) || !live || !isSessionChainAgentStep(live)) {
      return step
    }
    if (JSON.stringify(live.prompts ?? null) === JSON.stringify(step.prompts ?? null)) {
      return step
    }
    carried = true
    const { prompts: _stale, ...rest } = step
    return live.prompts ? { ...rest, prompts: live.prompts } : rest
  })
  return carried ? { ...chain, steps } : chain
}
