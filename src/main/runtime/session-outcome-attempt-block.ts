import {
  agentPromptAttention,
  attemptRequirementAttention
} from '../../shared/session-attention-drafts'
import type { SessionChain } from '../../shared/session-chain-types'
import type {
  HumanAttentionDraft,
  HumanAttentionRequest
} from '../../shared/session-human-attention'
import type {
  SessionOutcomeBlockClass,
  SessionOutcomeBlockInput
} from '../../shared/session-outcome-block'
import { sessionOutcomeActionStepId } from '../../shared/session-outcome-identity'
import type {
  SessionOutcome,
  SessionOutcomeAttempt,
  SessionOutcomeSet
} from '../../shared/session-outcome-types'
import type { OrcaRuntimeService } from './omni-runtime'
import {
  isCurrentStoppedAttempt,
  sessionAttemptRecoveryDecision
} from './session-outcome-attempt-recovery'

/**
 * What an outcome's attempts say about it, as a classified block. A stopped attempt reads through
 * the recovery ladder; a live agent asking its person something reads as that request. Nothing
 * here acts — the ladder's executor does — so the same reading holds on every pass and restart.
 */
export type SessionAttemptBlockReading = {
  /** Diagnostic prose for Details; never what decides the class. */
  reason: string
  block: SessionOutcomeBlockInput
  attention: HumanAttentionDraft[]
}

export const AGENT_PROMPT_BLOCK_CODE = 'agent-prompt'
export const UNVERIFIABLE_WORKER_BLOCK_CODE = 'worker-unverifiable'

// A person's answer comes first, then what the host is doing by itself, then what it waits for; a
// failure is said last, because only then will nothing more happen to this outcome by itself.
const CLASS_ORDER: SessionOutcomeBlockClass[] = ['attention', 'recovering', 'waiting', 'failed']

function agentName(chain: SessionChain, outcome: SessionOutcome, attempt: SessionOutcomeAttempt) {
  const stepId = sessionOutcomeActionStepId(attempt.actionId)
  const step = chain.steps.find((entry) => entry.id === stepId)
  const agent =
    (step && step.kind !== 'handoff' ? step.agent : undefined) ??
    outcome.actions.find((entry) => entry.id === attempt.actionId)?.agent
  return agent ? `${agent.charAt(0).toUpperCase()}${agent.slice(1)}` : 'The agent'
}

function workerPaneKey(
  runtime: OrcaRuntimeService,
  attempt: SessionOutcomeAttempt
): string | undefined {
  try {
    return attempt.dispatchId
      ? (runtime.getOrchestrationDb().getDispatchContextById(attempt.dispatchId)
          ?.assignee_pane_key ?? undefined)
      : undefined
  } catch {
    return undefined
  }
}

function attemptReading(
  runtime: OrcaRuntimeService,
  chain: SessionChain,
  set: SessionOutcomeSet,
  outcome: SessionOutcome,
  attempt: SessionOutcomeAttempt,
  now: number
): SessionAttemptBlockReading | null {
  const stepId = sessionOutcomeActionStepId(attempt.actionId)
  const scope: HumanAttentionRequest['scope'] = {
    outcomeId: outcome.id,
    outcomeRevision: outcome.revision,
    ...(chain.planVersion ? { planVersion: chain.planVersion } : {}),
    ...(stepId ? { stepId } : {}),
    attemptId: attempt.id
  }
  const agent = agentName(chain, outcome, attempt)
  if (attempt.state === 'running' && attempt.awaiting) {
    return {
      reason: attempt.awaiting.prompt,
      block: { class: 'attention', code: AGENT_PROMPT_BLOCK_CODE },
      attention: [
        agentPromptAttention({
          scope,
          kind: attempt.awaiting.kind,
          agent,
          prompt: attempt.awaiting.prompt,
          paneKey: attempt.awaiting.paneKey
        })
      ]
    }
  }
  if (!isCurrentStoppedAttempt(chain, set, attempt)) {
    return null
  }
  const decision = sessionAttemptRecoveryDecision(runtime, set, attempt, now)
  // Never empty: the set's schema refuses a blank reason, and that would cost the whole write.
  const reason = attempt.error?.trim() || 'The action stopped before it finished.'
  switch (decision.kind) {
    case 'none':
      return null
    case 'retry':
      // Due now: the ladder's executor replaces it on the host's next pass.
      return {
        reason,
        block: { class: 'recovering', code: codeOf(attempt), until: now },
        attention: []
      }
    case 'wait':
      return {
        reason,
        block: { class: 'recovering', code: codeOf(attempt), until: decision.until },
        attention: []
      }
    case 'hold':
      return {
        reason,
        block: {
          class: 'waiting',
          code: UNVERIFIABLE_WORKER_BLOCK_CODE,
          wake: 'worker contact',
          until: decision.until
        },
        attention: []
      }
    case 'attention':
      return {
        reason,
        block: { class: 'attention', code: decision.code },
        attention: [
          attemptRequirementAttention({
            requirement: decision.requirement,
            scope,
            agent,
            ...(attempt.failure?.detail ? { detail: attempt.failure.detail } : {}),
            paneKey: workerPaneKey(runtime, attempt)
          })
        ]
      }
    case 'fail':
      return { reason, block: { class: 'failed', code: decision.code }, attention: [] }
  }
}

function codeOf(attempt: SessionOutcomeAttempt): string {
  return (
    attempt.failure?.code ??
    (attempt.launchDisposition === 'not-started' ? 'launch-not-started' : 'unknown')
  )
}

/** The one block an outcome's attempts amount to, or null when none of them holds it. */
export function sessionOutcomeAttemptBlock(
  runtime: OrcaRuntimeService,
  chain: SessionChain,
  set: SessionOutcomeSet,
  outcome: SessionOutcome,
  now: number
): SessionAttemptBlockReading | null {
  const planVersion = chain.planVersion ?? 1
  const readings = set.attempts
    .filter(
      (attempt) =>
        attempt.outcomeId === outcome.id &&
        attempt.outcomeRevision === outcome.revision &&
        (attempt.planVersion ?? 1) >= planVersion
    )
    .flatMap((attempt) => attemptReading(runtime, chain, set, outcome, attempt, now) ?? [])
    .toSorted(
      (left, right) =>
        CLASS_ORDER.indexOf(left.block.class) - CLASS_ORDER.indexOf(right.block.class)
    )
  const first = readings[0]
  if (!first) {
    return null
  }
  return {
    ...first,
    // Every request of the outcome's attempts is asked at once, not one per answered prompt.
    attention: readings.flatMap((entry) => entry.attention)
  }
}
