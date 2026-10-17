/**
 * The same-conversation route: a step that CONTINUES the original agent instead of briefing a new
 * one (WP-4b).
 *
 * "Prompt Queue merely continues a conversation" is the invariant this is the chain-driven twin of.
 * A step routed `same-session` starts no worker, creates no Run, no Task and no Dispatch: the
 * step's brief goes through the person's own send door (`deliverToConversation`) into the
 * conversation the plan was authored from, so the agent answers WITH the memory of everything it
 * already did rather than being handed a transcript of it.
 *
 * Four rules, in order, every tick:
 *   1. the conversation must still be there — pane closed, session ended or unreadable is
 *      `blocked` with plain words, NEVER a quiet fallback to a new session (an exited waiter of a
 *      session wait is first resumed as the SAME conversation, `session-outcome-conversation-revive`);
 *   2. nothing else may be mid-delivery on it — the queue drain refuses while a live plan is bound
 *      to the conversation, and this refuses while a queued prompt is `sending`, so the person's
 *      own text and a plan's turn can never interleave;
 *   3. the last turn must have finished (`observeConversationReadiness` — the same reading the
 *      drain and the chain's source oracle use);
 *   4. the delivery receipt is durable BEFORE a byte moves, so a restart reconciles it.
 *
 * Settlement is the NEXT ending of that conversation: readiness carries the identity of the turn
 * that finished, so an ending whose version is still the one we delivered after is not ours. What
 * that turn said becomes the step's report on disk, which is what makes a continued step
 * indistinguishable from a worker to `readsFrom`, to the review candidate version and to the
 * verdict consumer.
 */

import { randomUUID } from 'node:crypto'
import {
  conversationDeliveryOperationId,
  type ConversationSource
} from '../../shared/conversation-source'
import { outcomeChainCardBound } from '../../shared/outcome-chain-concurrency'
import type { SessionChain } from '../../shared/session-chain-types'
import { sessionOutcomeActionStepId } from '../../shared/session-outcome-identity'
import { sessionOutcomeConversationSource } from '../../shared/session-outcome-conversation-turn'
import type { SessionOutcomeAttempt } from '../../shared/session-outcome-types'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../shared/structured-agent-session-projection'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { observeConversationReadiness } from './conversation-readiness'
import { deliverToConversation } from './conversation-delivery'
import type { OrcaRuntimeService } from './omni-runtime'
import { isPromptQueueSendingOnConversation } from './prompt-queue-drain'
import {
  CONVERSATION_REPORT_UNAVAILABLE,
  writeConversationReport
} from './session-outcome-conversation-report'
import { launchNotStartedFailure } from './session-outcome-attempt-failure'
import { sessionHostRetryRule } from '../../shared/session-host-refusal'
import { SessionHostDeliveryRefusedError } from '../session-host/session-host-delivery-admission'
import {
  isResumedTurnVersion,
  reviveSameConversation,
  resumedTurnVersion
} from './session-outcome-conversation-revive'

export const SAME_CONVERSATION_GONE =
  'The original conversation is no longer available, so this step cannot continue it. Reopen that session, or plan this step as a new agent.'

export const SAME_CONVERSATION_CARD_BOUND =
  "This plan continues a card's own worker, so a step cannot also continue the original conversation."

/** A delivery this process cannot account for; the same reading the prompt queue makes. */
export const SAME_CONVERSATION_UNCONFIRMED =
  'OmniConsole restarted while this step was being delivered to the original conversation, so it cannot confirm the agent received it. Retry this step if the agent never answered it.'

type TurnInput = {
  runtime: OrcaRuntimeService
  chain: SessionChain
  attempt: SessionOutcomeAttempt
  /**
   * The step's full execution brief, exactly as a worker would have received it. Lazy, because it
   * is only needed on the tick that actually delivers — and because a brief that cannot be built
   * (one too large for a step) must refuse this attempt rather than throw inside the host tick.
   */
  brief: () => string
  persist: (attempt: SessionOutcomeAttempt) => void
}

/** A step continues the ORIGINAL conversation: the pane this chain's plan was authored from. */
export function sameConversationSource(
  runtime: OrcaRuntimeService,
  chain: SessionChain
): ConversationSource | null {
  const worktreeId = chain.sourceWorktreeId ?? chain.worktreeId
  const chat = (getStructuredAgentSessionHost()?.listSessionTabs() ?? []).filter(
    (session) =>
      session.workspaceId === worktreeId &&
      structuredAgentSessionPaneKey(
        structuredAgentSessionTabId(session.sessionId),
        session.sessionId
      ) === chain.sourcePaneKey
  )
  if (chat.length === 1) {
    return {
      worktreeId,
      paneKey: chain.sourcePaneKey,
      kind: 'structured',
      sessionId: chat[0]!.sessionId
    }
  }
  try {
    runtime.resolveTerminalPane(chain.sourcePaneKey, worktreeId)
  } catch {
    // The pane is gone. That is a definite reading, and the only honest answer is a refusal.
    return null
  }
  return { worktreeId, paneKey: chain.sourcePaneKey, kind: 'pty' }
}

function blocked(
  attempt: SessionOutcomeAttempt,
  error: string,
  disposition: 'not-started' | 'started' | 'unverifiable',
  cause?: unknown
): SessionOutcomeAttempt {
  const now = Date.now()
  return {
    ...attempt,
    state: 'blocked',
    launchDisposition: disposition,
    error,
    // Only a turn that provably never went out may be tried again; a delivered one has no code,
    // so the ladder holds it as unverifiable and never sends the conversation a second turn.
    ...(disposition === 'not-started' ? { failure: launchNotStartedFailure(cause, now) } : {}),
    updatedAt: now
  }
}

/**
 * Deliver the brief if — and only if — the conversation is free, then record the receipt. A
 * conversation that is merely busy, or whose agent is asking the person something, leaves the
 * attempt exactly as it is: it holds its slot and this runs again next tick. No error is written
 * on a waiting attempt, because an attempt with an error blocks its outcome.
 */
async function deliverTurn(input: TurnInput): Promise<SessionOutcomeAttempt> {
  const { runtime, chain, attempt } = input
  const turn = attempt.conversationTurn!
  const source = sessionOutcomeConversationSource(turn)
  if (isPromptQueueSendingOnConversation(runtime, source)) {
    return attempt
  }
  const readiness = await observeConversationReadiness(runtime, source)
  if (readiness.unverifiable) {
    return blocked(attempt, readiness.reason ?? SAME_CONVERSATION_GONE, 'not-started')
  }
  // A finished turn with no identity cannot be told apart from the one this delivery will produce,
  // and settling on the wrong ending would report the previous answer as this step's work. A pane
  // just resumed for this step has no ending yet: free at its prompt is enough there.
  const resumedAtPrompt =
    isResumedTurnVersion(turn.turnVersion) && !readiness.version && readiness.free
  if (!resumedAtPrompt && (!readiness.ready || !readiness.version)) {
    return attempt
  }
  let brief: string
  try {
    brief = input.brief()
  } catch (error) {
    // Nothing was delivered, so retrying duplicates nothing — but only a shorter brief can pass.
    return blocked(
      attempt,
      error instanceof Error ? error.message : String(error),
      'not-started',
      error
    )
  }
  const operationId = conversationDeliveryOperationId('same-session', randomUUID())
  // The receipt lands on disk BEFORE a byte moves: past this point there is either a delivery or
  // a recorded uncertainty, never a silent second send.
  const sending: SessionOutcomeAttempt = {
    ...attempt,
    state: 'launching',
    conversationTurn: {
      ...turn,
      operationId,
      epoch: chain.outcomeSet!.continuation.epoch,
      turnVersion: readiness.version ?? turn.turnVersion
    },
    updatedAt: Date.now()
  }
  input.persist(sending)
  try {
    const delivery = await deliverToConversation(runtime, source, brief, {
      operationId,
      hostAdmission: { writer: 'same-session' }
    })
    return {
      ...sending,
      // The agent has the work. Retrying would be a second turn of the same conversation, so only
      // a settled failure may make this attempt retryable.
      launchDisposition: 'started',
      state: 'running',
      conversationTurn: { ...sending.conversationTurn!, deliveredAt: delivery.deliveredAt },
      updatedAt: Date.now()
    }
  } catch (error) {
    // Admission refused before a byte moved: another writer holds this turn (wait for the next),
    // or the conversation's host cannot take it (blocked, nothing sent).
    if (error instanceof SessionHostDeliveryRefusedError) {
      return sessionHostRetryRule(error.refusal.code) === 'new-operation-after-observe'
        ? attempt
        : blocked(attempt, error.message, 'not-started', error)
    }
    // The send door refused or lost contact. It is not proof the bytes never arrived, so this is
    // reported rather than repeated; the operation id stays on the attempt either way.
    return {
      ...sending,
      state: 'unverifiable',
      launchDisposition: 'unverifiable',
      error: error instanceof Error ? error.message : String(error),
      updatedAt: Date.now()
    }
  }
}

/** The ending after ours, and what it said. */
async function settleTurn(input: TurnInput): Promise<SessionOutcomeAttempt> {
  const { runtime, chain, attempt } = input
  const turn = attempt.conversationTurn!
  const source = sessionOutcomeConversationSource(turn)
  const readiness = await observeConversationReadiness(runtime, source)
  if (readiness.unverifiable) {
    return blocked(attempt, readiness.reason ?? SAME_CONVERSATION_GONE, 'started')
  }
  // Not ready is the agent working; ready at the version we delivered after is the SAME ending we
  // already read, so our turn has not finished. Either way this attempt is still running.
  if (!readiness.ready || !readiness.version || readiness.version === turn.turnVersion) {
    return attempt
  }
  // A chat-filed action is its own report's owner; a step's action is reported under the step.
  const stepId =
    sessionOutcomeActionStepId(attempt.actionId) ??
    (/^[A-Za-z0-9_-]{1,64}$/.test(attempt.actionId) ? attempt.actionId : null)
  if (!stepId) {
    return blocked(attempt, 'This continued turn does not belong to a step of the plan.', 'started')
  }
  try {
    const captured = await runtime.readSessionOutcomeSourceContext(
      source.paneKey,
      source.worktreeId
    )
    const hook =
      source.kind === 'pty'
        ? runtime.getFreshAgentHookStatusForHandle(
            runtime.resolveTerminalPane(source.paneKey, source.worktreeId).handle
          )
        : null
    const body =
      captured?.summary.trim() ||
      (hook?.state === 'done' ? (hook.lastAssistantMessage ?? '').trim() : '') ||
      CONVERSATION_REPORT_UNAVAILABLE
    const reportPath = await writeConversationReport(chain, stepId, body)
    return {
      ...attempt,
      state: 'completed',
      launchDisposition: 'started',
      conversationTurn: { ...turn, reportPath },
      updatedAt: Date.now(),
      error: undefined
    }
  } catch (error) {
    return blocked(attempt, error instanceof Error ? error.message : String(error), 'started')
  }
}

/**
 * One step of the route, idempotent and safe to call every tick: bind the conversation, deliver
 * when it is free, then settle on the turn that answered. The launch calls it once; the host tick
 * calls it for as long as the attempt is unsettled.
 */
export async function advanceSameConversationTurn(
  input: TurnInput
): Promise<SessionOutcomeAttempt> {
  const { chain, attempt } = input
  if (outcomeChainCardBound(chain.outcomeSet!.continuation)) {
    return blocked(attempt, SAME_CONVERSATION_CARD_BOUND, 'not-started')
  }
  if (!attempt.conversationTurn) {
    let source = sameConversationSource(input.runtime, chain)
    // An exited waiter is resumed before rule 1 refuses; one that cannot be is Stalled, in words.
    const revived = await reviveSameConversation(input.runtime, chain, source)
    if (revived?.kind === 'stalled') {
      return blocked(attempt, revived.reason, 'not-started')
    }
    if (revived?.kind === 'resumed') {
      source = revived.source
    }
    if (!source) {
      return blocked(attempt, SAME_CONVERSATION_GONE, 'not-started')
    }
    const bound: SessionOutcomeAttempt = {
      ...attempt,
      state: 'launching',
      conversationTurn: {
        ...source,
        ...(revived?.kind === 'resumed' ? { turnVersion: resumedTurnVersion(source.paneKey) } : {})
      },
      updatedAt: Date.now()
    }
    input.persist(bound)
    return await deliverTurn({ ...input, attempt: bound })
  }
  const turn = attempt.conversationTurn
  if (turn.deliveredAt) {
    return await settleTurn(input)
  }
  if (turn.operationId && turn.epoch !== chain.outcomeSet!.continuation.epoch) {
    // A send whose result THIS process cannot know. The prompt queue settles the same case the
    // same way: recorded as unaccounted for, never re-sent.
    return blocked(attempt, SAME_CONVERSATION_UNCONFIRMED, 'unverifiable')
  }
  return await deliverTurn(input)
}
