import { assertOpenRouterRoute } from '../../shared/openrouter-route'
import { NEXT_STEP_MAX_REVIEW_ROUNDS, NEXT_STEP_MAX_REVIEWERS } from '../../shared/next-step-draft'
import { sessionOutcomeReviewerIdentity } from './session-outcome-reviewer-identity'
import { OUTCOME_AGENT_MISSION } from '../../shared/outcome-agent-mission'
import { orderSessionOutcomeStages } from './session-outcome-workflow-order'
import { sessionOutcomeCurrentActionKey } from './session-outcome-workflow-current-inputs'
import type { SessionOutcomeCurrentRoute } from './session-outcome-workflow-current-inputs'
import type { SessionOutcomeCurrentInput } from '../../shared/session-outcome-current-inputs'
import { createHash } from 'node:crypto'
import type { SessionChain, SessionChainAgentStep } from '../../shared/session-chain-types'
import type { ConsoleWorkflowStep } from '../../shared/console-workflow-types'
import { sessionOutcomeDefinition } from '../../shared/session-outcome-types'
import type {
  SessionOutcomeWorkflow,
  SessionOutcomeStageReceipt
} from '../../shared/session-outcome-workflow'

export {
  sessionOutcomeWorkflowDefinition,
  sessionOutcomeWorkflowDefinitionHash
} from './session-outcome-workflow-definition'
function actor(
  step: Pick<SessionChainAgentStep, 'agent' | 'model' | 'accountChoiceId' | 'openrouterCandidates'>
): string {
  assertOpenRouterRoute(step)
  if (
    !['codex', 'claude', 'grok', 'omp'].includes(step.agent) ||
    !step.model ||
    step.accountChoiceId
  ) {
    throw new Error(
      'Admitted stages require a supported exact model without an unrepresentable account override.'
    )
  }
  return `${step.agent}:${step.model}`
}

/** Only authoring: the canonical server expands rounds, decides branches and owns stage completion. */
export type SessionOutcomePredecessor = {
  receipt: SessionOutcomeStageReceipt
  effort?: string
}
export function compileSessionOutcomeWorkflow(
  chain: SessionChain,
  sources = new Map<string, SessionOutcomePredecessor>(),
  currentRoutes = new Map<string, SessionOutcomeCurrentRoute>()
): {
  currentInputs: SessionOutcomeCurrentInput[]
  stages: ConsoleWorkflowStep[]
  bindings: SessionOutcomeWorkflow['stages']
  predecessorReceipts: NonNullable<SessionOutcomeWorkflow['predecessorReceipts']>
} {
  const currentInputs: SessionOutcomeCurrentInput[] = []
  const set = chain.outcomeSet!
  const stages: ConsoleWorkflowStep[] = []
  const bindings: SessionOutcomeWorkflow['stages'] = []
  const predecessorReceipts: NonNullable<SessionOutcomeWorkflow['predecessorReceipts']> = []
  const consumed = new Set<string>()
  const fullIntent = JSON.stringify(set.outcomes.map(sessionOutcomeDefinition))
  const owner = (id: string) => set.outcomes.find((outcome) => outcome.stepIds?.includes(id))!
  const agentSteps = chain.steps.filter(
    (step): step is SessionChainAgentStep =>
      step.kind !== 'handoff' && (step.planVersion ?? 1) === (chain.planVersion ?? 1)
  )
  for (const original of agentSteps) {
    if (consumed.has(original.id)) {
      continue
    }
    const source = sources.get(original.id)
    const current = currentRoutes.get(original.id)
    const reviewOnly = Boolean(original.review && (source || current))
    let step: SessionChainAgentStep = reviewOnly
      ? {
          id: original.id,
          agent: (current?.provider ?? source!.receipt.provider) as SessionChainAgentStep['agent'],
          model: current?.model ?? source!.receipt.model,
          effort: current?.effort ?? source?.effort,
          status: 'queued',
          prompt: current
            ? 'Review the captured completed source files and final response. Repair them only when the saved review policy authorizes repairs and reviewers report findings.'
            : 'Review the authenticated accepted predecessor; implement repairs only if the canonical review loop requires them.'
        }
      : original
    if ((!reviewOnly && step.review) || step.reviewRepair) {
      throw new Error('A canonical review group requires its producer before its reviewers.')
    }
    const key = `next_${createHash('sha256').update(step.id).digest('hex').slice(0, 20)}`
    const index = agentSteps.indexOf(original)
    const following = agentSteps.slice(index + (reviewOnly ? 0 : 1))
    const first = following[0]
    const reviewId = first?.review?.groupId
    const reviewers = reviewId
      ? following.filter((entry) => entry.review?.groupId === reviewId && entry.review.round === 1)
      : []
    const groupSteps = reviewId
      ? following.filter(
          (entry) => entry.review?.groupId === reviewId || entry.reviewRepair?.groupId === reviewId
        )
      : []
    const repair = groupSteps.find((entry) => entry.reviewRepair?.groupId === reviewId)
    if (reviewOnly && repair) {
      // The completed source actor attests provenance; the selected repair actor owns repair execution.
      step = {
        ...step,
        agent: repair.agent,
        model: repair.model,
        openrouterCandidates: repair.openrouterCandidates,
        effort: repair.effort,
        prompt: repair.prompt
      }
    }
    if (!reviewOnly && repair && (actor(repair) !== actor(step) || repair.effort !== step.effort)) {
      throw new Error(
        'This task workflow cannot preserve a different producer and repair model or effort. Use a separate review after the producer completes.'
      )
    }
    if (
      reviewers.length &&
      [step, ...groupSteps].some((entry) => entry.openrouterCandidates !== undefined)
    ) {
      throw new Error(
        'Canonical review loops cannot preserve per-seat OpenRouter fallback routes. Use fixed models or separate stages.'
      )
    }
    if (groupSteps.some((entry) => entry.accountChoiceId)) {
      throw new Error('This canonical loop cannot preserve account overrides.')
    }
    if (reviewers.length) {
      if (
        reviewers.length > NEXT_STEP_MAX_REVIEWERS ||
        reviewers[0]!.review!.maxRounds > NEXT_STEP_MAX_REVIEW_ROUNDS
      ) {
        throw new Error('Canonical reviews support up to five reviewers and five rounds.')
      }
      if (reviewers[0]!.review!.maxRounds > 1 && !repair) {
        throw new Error(
          'Choose an authorized repair step before requesting multiple review rounds.'
        )
      }
    }
    const members = reviewOnly ? groupSteps : [step, ...groupSteps]
    const participants = [actor(step), ...reviewers.map(actor)]
    const participantIds =
      // #284 widened when distinct identities are required: not only when two participants
      // collide with each other, but also when a reviewer is the same actor as the completed
      // source's producer. #283's shared helper computes the same reviewer identity.
      reviewers.length &&
      (new Set(participants).size !== participants.length ||
        reviewers.some(
          (reviewer) =>
            actor(reviewer) ===
            `${current?.producer?.provider ?? source?.receipt.provider}:${current?.producer?.model ?? source?.receipt.model}`
        ))
        ? [
            `producer_${createHash('sha256').update(step.id).digest('hex').slice(0, 24)}`,
            ...reviewers.map((entry) => sessionOutcomeReviewerIdentity(entry.review!))
          ]
        : undefined
    members.forEach((entry) => consumed.add(entry.id))
    const prompts = members
      .map((entry) => `${entry.id} (${actor(entry)}):\n${entry.prompt}`)
      .join('\n\n')
    const prompt = [
      OUTCOME_AGENT_MISSION,
      step.prompt,
      'The following frozen original outcome set remains binding. This stage may fulfill only its scoped work; do not complete, reassign or approve the original hub card.',
      fullIntent,
      'Exact saved stage instructions (review/repair instructions apply only to their named roles):',
      prompts,
      'Review verdict notes must retain the actual candidate Git SHA and PR URL, or the supplied captured source snapshot digest. The canonical verdict contract supplied by this admitted stage is authoritative.'
    ].join('\n\n')
    if (prompt.length > 32_000) {
      throw new Error('The complete outcome plan exceeds canonical stage brief limits.')
    }
    stages.push({
      key,
      title: owner(step.id)?.title ?? step.id,
      prompt,
      actor: actor(step),
      ...(step.openrouterCandidates !== undefined
        ? { openrouter_candidates: [...step.openrouterCandidates] }
        : {}),
      actor_type: 'ai',
      action: 'execute',
      ...(step.effort ? { effort: step.effort } : {}),
      after: [],
      ...(reviewers.length
        ? {
            loop: {
              kind: reviewers.some((entry) => entry.review?.adversarial)
                ? ('adversarial' as const)
                : ('review' as const),
              participants,
              ...(participantIds ? { participant_ids: participantIds } : {}),
              ...(reviewers.some((entry) => entry.effort !== step.effort)
                ? {
                    participant_efforts: Object.fromEntries(
                      [step, ...reviewers].map((entry, index) => [
                        participantIds?.[index] ?? actor(entry),
                        entry.effort ?? null
                      ])
                    )
                  }
                : {}),
              max_rounds: reviewers[0]!.review!.maxRounds,
              stop_rule: 'zero_blockers' as const
            }
          }
        : {})
    })
    if (current) {
      currentInputs.push({
        stage_key: key,
        mode: reviewOnly ? 'review-source' : 'base',
        files: current.files,
        ...(current.producer ? { producer: current.producer } : {}),
        ...(current.git ? { git: current.git } : {})
      })
    }
    if (source) {
      predecessorReceipts.push({
        stage_key: key,
        job_id: source.receipt.jobId,
        receipt_event_id: source.receipt.eventId,
        fingerprint: source.receipt.fingerprint,
        mode: reviewOnly ? 'review-source' : 'base'
      })
    }
    bindings.push({
      key,
      stepIds: members.map((entry) => entry.id),
      outcomeIds: [
        ...new Set(members.map((entry) => owner(entry.id)?.id).filter((id): id is string => !!id))
      ],
      actionIds: [],
      ...(reviewId ? { reviewGroupId: reviewId } : {})
    })
  }
  // Saved agent actions remain real user-authorized stages. Finish=merge adds a later host effect.
  for (const outcome of set.outcomes) {
    for (const action of outcome.actions) {
      const key = `next_${createHash('sha256')
        .update(`${outcome.id}:${action.id}`)
        .digest('hex')
        .slice(0, 20)}`
      if (action.instruction.length + fullIntent.length > 30_000) {
        throw new Error('The stage instruction exceeds the canonical graph limit.')
      }
      stages.push({
        key,
        title: outcome.title,
        prompt: `${OUTCOME_AGENT_MISSION}\n\n${action.instruction}\n\nOriginal obligations: ${fullIntent}`,
        actor: actor(action),
        ...(action.openrouterCandidates !== undefined
          ? { openrouter_candidates: [...action.openrouterCandidates] }
          : {}),
        actor_type: 'ai',
        action: 'execute',
        ...(action.effort ? { effort: action.effort } : {}),
        after: []
      })
      const current = currentRoutes.get(sessionOutcomeCurrentActionKey(outcome.id, action.id))
      if (current) {
        currentInputs.push({
          stage_key: key,
          mode: 'base',
          files: current.files,
          ...(current.producer ? { producer: current.producer } : {}),
          ...(current.git ? { git: current.git } : {})
        })
      }
      bindings.push({ key, stepIds: [], outcomeIds: [outcome.id], actionIds: [action.id] })
    }
  }
  orderSessionOutcomeStages({ chain, bindings, stages })
  if (!stages.length) {
    throw new Error('An admitted outcome plan needs an executable stage before human acceptance.')
  }
  return { stages, bindings, predecessorReceipts, currentInputs }
}
