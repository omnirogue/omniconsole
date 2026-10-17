import {
  emptyNextStepDraft,
  type NextStepDraft,
  type NextStepActor,
  type NextStepOutcomeStep,
  type NextStepOutcomeFinish
} from '../../../../shared/next-step-draft'
import type { SessionChain, SessionChainStep } from '../../../../shared/session-chain-types'
import type { SessionFollowUpDeliverables } from '../../../../shared/session-follow-up-rule'
import {
  nextOutcomeParallelGroupKey,
  stripNextOutcomeOutputInstruction
} from '../../../../shared/next-outcome-compile'
import { outcomeDraftProgress } from '../../../../shared/next-outcome-draft-progress'

type OutcomeHandoffContext = {
  linked: { id: string; title: string } | null
  deliverables: SessionFollowUpDeliverables | null
}

export async function draftWithOutcomeHandoffContext({
  draft,
  context
}: {
  draft: NextStepDraft
  context: OutcomeHandoffContext
}): Promise<NextStepDraft> {
  if (!draft.outcomes?.some((outcome) => outcome.finish?.kind === 'person')) {
    return draft
  }
  const task = draft.handoff.task ?? context.linked
  return {
    ...draft,
    handoff: {
      ...draft.handoff,
      task,
      deliverables: draft.handoff.deliverables ?? context.deliverables
    }
  }
}

export function draftFromChain(chain: SessionChain): NextStepDraft {
  const draft = emptyNextStepDraft()
  const persistedHandoff = chain.steps.find((step) => step.kind === 'handoff')
  if (persistedHandoff?.kind === 'handoff') {
    draft.handoff = {
      task: persistedHandoff.handoff.taskId
        ? {
            id: persistedHandoff.handoff.taskId,
            title: persistedHandoff.handoff.taskTitle
          }
        : null,
      deliverables: structuredClone(persistedHandoff.handoff.deliverables),
      includeSummary: persistedHandoff.handoff.includeSummary,
      communicationType: persistedHandoff.handoff.communicationType,
      sourceConversationId: persistedHandoff.handoff.sourceConversationId,
      ...(persistedHandoff.handoff.transcriptSource
        ? {
            includeTranscript: true,
            transcriptSource: structuredClone(persistedHandoff.handoff.transcriptSource)
          }
        : {}),
      destinationDirectory: persistedHandoff.handoff.destinationDirectory,
      ...(persistedHandoff.handoff.dueAt ? { dueAt: persistedHandoff.handoff.dueAt } : {}),
      ...(persistedHandoff.handoff.action ? { action: persistedHandoff.handoff.action } : {})
    }
    draft.note = persistedHandoff.handoff.note
    if (persistedHandoff.handoff.noteAuthored) {
      draft.noteAuthored = true
    }
  }
  draft.outcomes = chain.outcomeSet!.outcomes.map((outcome) => ({
    id: outcome.id,
    revision: outcome.revision,
    instructions: outcome.instructions ?? '',
    steps: outcomeStepsFromChain(chain, outcome.id),
    ...outcomeDraftProgress(outcome, chain.outcomeSet, chain.planVersion ?? 1),
    finish:
      outcome.finish === 'complete'
        ? { kind: 'complete' }
        : outcome.finish === 'my-review'
          ? { kind: 'my-review' }
          : outcome.finish === 'human-handoff'
            ? personFinish(chain, outcome.id)
            : {
                kind: 'github',
                action:
                  outcome.finish === 'pr'
                    ? 'create-pr'
                    : outcome.finish === 'merge'
                      ? 'merge'
                      : 'merge-and-deploy',
                repository: outcome.conditions[0]?.repository,
                targetBranch: outcome.conditions.find(
                  (entry) => entry.kind === 'pr' || entry.kind === 'merge'
                )?.targetBranch,
                deploymentTarget: outcome.conditions.find((entry) => entry.kind === 'deployment')
                  ?.target
              }
  }))
  return draft
}

function actorFromStep(step: Extract<SessionChainStep, { kind?: 'agent' }>): NextStepActor {
  return {
    agent: step.agent,
    ...(step.model ? { model: step.model } : {}),
    ...(step.openrouterCandidates !== undefined
      ? { openrouterCandidates: [...step.openrouterCandidates] }
      : {}),
    ...(step.effort ? { effort: step.effort } : {}),
    ...(step.accountChoiceId ? { accountChoiceId: step.accountChoiceId } : {})
  }
}

function legacyEditorStepId(step: Extract<SessionChainStep, { kind?: 'agent' }>): string {
  if (step.editorStepId) {
    return step.editorStepId
  }
  if (step.review) {
    const prefix = `review_${step.outcomeId ?? ''}_`
    return step.review.groupId.startsWith(prefix)
      ? step.review.groupId.slice(prefix.length)
      : step.review.groupId
  }
  const prefix = `${step.outcomeId ?? ''}_`
  const withoutOutcome = step.id.startsWith(prefix) ? step.id.slice(prefix.length) : step.id
  const repairSuffix = step.reviewRepair ? `_repair-after-${step.reviewRepair.afterRound}` : ''
  return repairSuffix && withoutOutcome.endsWith(repairSuffix)
    ? withoutOutcome.slice(0, -repairSuffix.length)
    : withoutOutcome
}

function editorInstructions(
  chain: SessionChain,
  step: Extract<SessionChainStep, { kind?: 'agent' }>
): string {
  return step.review
    ? step.prompt
    : stripNextOutcomeOutputInstruction(step.prompt, chain.workspacePath, chain.id, step.id)
}

/** Rebuild the editable ordering from persisted compiled steps; outcome definitions alone omit it. */
function outcomeStepsFromChain(chain: SessionChain, outcomeId: string): NextStepOutcomeStep[] {
  const steps = chain.steps
  const outcomeSteps = steps.filter((step) => step.outcomeId === outcomeId)
  const restored: NextStepOutcomeStep[] = []
  const handledReviewGroups = new Set<string>()
  for (const step of outcomeSteps) {
    if (step.kind === 'handoff' || step.reviewRepair) {
      continue
    }
    if (step.review) {
      const { groupId } = step.review
      if (handledReviewGroups.has(groupId)) {
        continue
      }
      handledReviewGroups.add(groupId)
      const reviewSteps = outcomeSteps.filter(
        (candidate): candidate is Extract<SessionChainStep, { kind?: 'agent' }> =>
          candidate.kind !== 'handoff' && candidate.review?.groupId === groupId
      )
      const firstRound = reviewSteps
        .filter((candidate) => candidate.review?.round === 1)
        .sort((left, right) => left.review!.reviewerId.localeCompare(right.review!.reviewerId))
      restored.push({
        id: legacyEditorStepId(step),
        kind: 'review',
        reviewers: firstRound.map(actorFromStep),
        maxRounds: step.review.maxRounds,
        ...(step.review.repairWithSource ? { repairWithSource: true } : {}),
        instructions: editorInstructions(chain, step),
        adversarial: step.review.adversarial === true
      })
      const repair = outcomeSteps.find(
        (candidate): candidate is Extract<SessionChainStep, { kind?: 'agent' }> =>
          candidate.kind !== 'handoff' && candidate.reviewRepair?.groupId === groupId
      )
      if (repair && !repair.reviewRepair?.withSource) {
        restored.push({
          id: legacyEditorStepId(repair),
          kind: 'handoff',
          reviewRepair: true,
          actor: actorFromStep(repair),
          presetId: repair.presetId ?? 'implement',
          instructions: editorInstructions(chain, repair)
        })
      }
      continue
    }
    const parallelPrefix = nextOutcomeParallelGroupKey(outcomeId, '')
    restored.push({
      id: legacyEditorStepId(step),
      kind: 'handoff',
      actor: actorFromStep(step),
      presetId: step.presetId ?? 'implement',
      instructions: editorInstructions(chain, step),
      // Why: dropping the key on re-save would change the step signature and relaunch the team serially.
      ...(step.group?.startsWith(parallelPrefix)
        ? { parallelGroup: step.group.slice(parallelPrefix.length) }
        : {})
    })
  }
  return restored
}

function personFinish(
  chain: SessionChain,
  outcomeId: string
): Extract<NextStepOutcomeFinish, { kind: 'person' }> {
  const outcome = chain.outcomeSet!.outcomes.find((entry) => entry.id === outcomeId)!
  const personId = outcome.conditions.find((entry) => entry.kind === 'handoff')?.recipientId ?? ''
  const step = chain.steps.find(
    (entry) => entry.kind === 'handoff' && entry.outcomeId === outcomeId
  )
  const handoff = step?.kind === 'handoff' ? step.handoff : undefined
  const agentRecipient = handoff?.agentRecipients?.[0]
  return {
    kind: 'person',
    personId,
    personName:
      agentRecipient?.name ??
      handoff?.recipients.find((entry) => entry.employeeId === personId)?.name ??
      '',
    ...(agentRecipient
      ? {
          agentRecipient: {
            kind: agentRecipient.kind,
            id: agentRecipient.id,
            employeeId: agentRecipient.employeeId,
            projectId: agentRecipient.projectId,
            name: agentRecipient.name
          }
        }
      : {}),
    action: handoff?.action ?? 'review',
    disposition: outcome.conditions.some(
      (entry) => entry.kind === 'review' && entry.recipientId === personId
    )
      ? 'feedback'
      : 'ownership'
  }
}
