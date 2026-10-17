import {
  retainedNextOutcomeDefinition,
  type NextOutcomeCommittedContext
} from './next-outcome-intent-revision'
import { requireNextOutcomeIntent } from './next-outcome-intent'
import {
  sessionChainStepOutputDir,
  type SessionChainAgentStep,
  type SessionChainStep
} from './session-chain-types'
import type { NextStepActor, NextStepOutcomeDraft, NextStepOutcomeFinish } from './next-step-draft'
import { outcomeFinishPeople } from './next-outcome-compile'
import type { SessionOutcomeCondition, SessionOutcomeDefinition } from './session-outcome-types'

export type NextOutcomeDefinitionContext = {
  chainId: string
  workspacePath: string
  sessionLabel: string
  sourcePaneKey?: string
  fallbackActor: NextStepActor
  steps: readonly SessionChainStep[]
  workingBranch?: string
  workingHead?: string
  committed?: NextOutcomeCommittedContext
}

function safeId(outcomeId: string, suffix: string): string {
  return `${outcomeId.slice(0, Math.max(1, 127 - suffix.length))}_${suffix}`
}

/**
 * One person, one obligation. A handoff needs a delivery receipt; a review needs the
 * person's answer as well, so it gets a `review` condition too — and with several
 * reviewers there is one PAIR PER PERSON, which is what makes "the track continues when
 * every reviewer has replied" a fact the host enforces rather than a sentence in the UI.
 *
 * The one-person ids are exactly what they were before several were possible
 * (`<outcome>_handoff` / `<outcome>_feedback`), so an existing chain keeps its receipts.
 */
function personConditions(
  outcomeId: string,
  finish: Extract<NextStepOutcomeFinish, { kind: 'person' }>
): SessionOutcomeCondition[] {
  const people = outcomeFinishPeople(finish)
  const suffix = (index: number): string => (people.length > 1 ? `_${index + 1}` : '')
  return people.flatMap((person, index) => [
    {
      id: safeId(outcomeId, `handoff${suffix(index)}`),
      kind: 'handoff' as const,
      target: person.id,
      recipientId: person.id,
      ...(finish.agentRecipient && person.id === finish.personId
        ? { recipientSessionId: finish.agentRecipient.id }
        : {})
    },
    ...(finish.disposition === 'feedback' && !finish.agentRecipient
      ? [
          {
            id: safeId(outcomeId, `feedback${suffix(index)}`),
            kind: 'review' as const,
            target: person.id,
            recipientId: person.id
          }
        ]
      : [])
  ])
}

function outcomeResultPath(context: NextOutcomeDefinitionContext, outcomeId: string): string {
  const dir = sessionChainStepOutputDir(
    context.workspacePath,
    context.chainId,
    `outcome_${outcomeId.slice(0, 48)}`
  )
  return `${dir}/result.md`
}

function outcomeSteps(
  context: NextOutcomeDefinitionContext,
  outcomeId: string
): SessionChainStep[] {
  return context.steps.filter((step) => step.outcomeId === outcomeId)
}

function completeCondition(
  outcome: NextStepOutcomeDraft,
  context: NextOutcomeDefinitionContext,
  steps: readonly SessionChainStep[]
): SessionOutcomeCondition[] {
  const intent = requireNextOutcomeIntent(outcome.instructions)
  if (intent.kind === 'files') {
    return intent.targets.map((target, index) => ({
      id: safeId(outcome.id, `file_${index + 1}`),
      kind: 'file',
      target
    }))
  }
  const writerIndex = steps.findLastIndex(
    (step) => step.kind !== 'handoff' && !step.review && !step.reviewRepair
  )
  const finalWriter = steps[writerIndex]
  const reviewers = steps
    .slice(writerIndex + 1)
    .filter(
      (step): step is SessionChainAgentStep => step.kind !== 'handoff' && Boolean(step.review)
    )
  const finalReviewGroup = reviewers.at(-1)?.review?.groupId
  // Later writers or review-group repairs can make an earlier group's reports stale.
  const reports: SessionOutcomeCondition[] = reviewers
    .filter((step) => step.review?.groupId === finalReviewGroup && step.review?.round === 1)
    .map((step, index) => ({
      id: safeId(outcome.id, `report_${index + 1}`),
      kind: 'report',
      target: step.id
    }))
  if (
    reports.length > 0 &&
    steps.every((step) => step.kind !== 'handoff' && (step.review || step.reviewRepair))
  ) {
    return reports
  }
  return [
    {
      id: safeId(outcome.id, 'result'),
      kind: 'file',
      target: finalWriter
        ? `${sessionChainStepOutputDir(context.workspacePath, context.chainId, finalWriter.id)}/manifest.md`
        : outcomeResultPath(context, outcome.id)
    },
    ...reports
  ]
}

function githubConditions(
  outcome: NextStepOutcomeDraft,
  context: NextOutcomeDefinitionContext,
  pinCurrentHead: boolean
): SessionOutcomeCondition[] {
  const finish = outcome.finish
  if (finish?.kind !== 'github') {
    return []
  }
  if (finish.action === 'merge-and-deploy') {
    throw new Error(
      'unsupported: Bind the project deployment target and an existing authorized deployment verifier through the source outcome before saving. A merge receipt or written report cannot prove deployment.'
    )
  }
  const repository = finish.repository?.trim()
  const branch = context.workingBranch?.replace(/^refs\/heads\//, '').trim()
  if (!repository || !branch) {
    throw new Error('Repository and current working branch are required for this Git outcome.')
  }
  const reviewCondition: SessionOutcomeCondition = {
    id: safeId(outcome.id, finish.action === 'create-pr' ? 'pr' : 'merge'),
    kind: finish.action === 'create-pr' ? 'pr' : 'merge',
    target: repository,
    repository,
    branch,
    ...(finish.targetBranch?.trim() ? { targetBranch: finish.targetBranch.trim() } : {}),
    ...(pinCurrentHead && context.workingHead?.trim()
      ? { version: context.workingHead.trim() }
      : {})
  }
  return [reviewCondition]
}

function finishInstruction(
  outcome: NextStepOutcomeDraft,
  conditions: SessionOutcomeCondition[]
): string {
  const finish = outcome.finish!
  if (finish.kind === 'github') {
    const action =
      finish.action === 'create-pr'
        ? 'Create the review request'
        : finish.action === 'merge'
          ? 'Merge after required checks and reviews pass'
          : 'Merge after required checks and reviews pass, then deploy and verify the deployment'
    return [
      action,
      `Repository: ${finish.repository}`,
      finish.targetBranch ? `Merge target branch: ${finish.targetBranch}` : null,
      finish.deploymentTarget ? `Deployment target: ${finish.deploymentTarget}` : null,
      outcome.instructions || null
    ]
      .filter((line): line is string => line !== null)
      .join('\n')
  }
  if (finish.kind === 'my-review') {
    return outcome.instructions
  }
  return [
    outcome.instructions || 'Complete the requested outcome using the existing session context.',
    `Produce the actual requested deliverable at each committed file destination: ${conditions
      .filter((condition) => condition.kind === 'file')
      .map((condition) => condition.target)
      .join(', ')}. Preserve existing destinations; process exit alone is not success.`
  ].join('\n\n')
}

export function compileNextStepOutcomes(
  outcomes: readonly NextStepOutcomeDraft[],
  context: NextOutcomeDefinitionContext
): SessionOutcomeDefinition[] {
  return outcomes.map((outcome, index) => {
    if (!outcome.finish) {
      throw new Error('Define a finish for every outcome.')
    }
    const steps = outcomeSteps(context, outcome.id)
    const retained = retainedNextOutcomeDefinition(
      outcome,
      context.committed,
      steps.map((step) => step.id)
    )
    if (retained) {
      return retained
    }
    const sourceOnly =
      outcome.finish.kind === 'complete' &&
      !outcome.instructions.trim() &&
      steps.length === 0 &&
      context.sourcePaneKey
    const conditions: SessionOutcomeCondition[] = sourceOnly
      ? [{ id: safeId(outcome.id, 'source'), kind: 'session', target: context.sourcePaneKey! }]
      : outcome.finish.kind === 'my-review'
        ? [{ id: safeId(outcome.id, 'review'), kind: 'review' as const, target: outcome.id }]
        : outcome.finish.kind === 'person'
          ? personConditions(outcome.id, outcome.finish)
          : outcome.finish.kind === 'github'
            ? githubConditions(
                outcome,
                context,
                !steps.some((step) => step.kind !== 'handoff' && !step.review)
              )
            : completeCondition(outcome, context, steps)
    const needsFinishWriter =
      (outcome.finish.kind === 'complete' && steps.length === 0 && !sourceOnly) ||
      (outcome.finish.kind === 'my-review' && Boolean(outcome.instructions.trim()))
    const needsRepositoryAction = outcome.finish.kind === 'github'
    const actions =
      needsFinishWriter || needsRepositoryAction
        ? [
            {
              id: safeId(outcome.id, 'finish'),
              instruction: finishInstruction(outcome, conditions),
              conditionIds: conditions.map((condition) => condition.id),
              authority: 'existing-user-authority' as const,
              agent: context.fallbackActor.agent,
              ...(context.fallbackActor.model ? { model: context.fallbackActor.model } : {}),
              ...(context.fallbackActor.openrouterCandidates !== undefined
                ? {
                    openrouterCandidates: [...context.fallbackActor.openrouterCandidates]
                  }
                : {}),
              ...(context.fallbackActor.effort ? { effort: context.fallbackActor.effort } : {}),
              ...(context.fallbackActor.accountChoiceId
                ? { accountChoiceId: context.fallbackActor.accountChoiceId }
                : {})
            }
          ]
        : []
    return {
      id: outcome.id,
      title: outcome.instructions || `${context.sessionLabel} — outcome ${index + 1}`,
      finish:
        outcome.finish.kind === 'person'
          ? 'human-handoff'
          : outcome.finish.kind === 'github'
            ? outcome.finish.action === 'create-pr'
              ? 'pr'
              : outcome.finish.action === 'merge'
                ? 'merge'
                : 'deploy'
            : outcome.finish.kind,
      ...(outcome.instructions ? { instructions: outcome.instructions } : {}),
      dependsOn:
        context.committed?.definitions.find((entry) => entry.id === outcome.id)?.dependsOn ?? [],
      ...(steps.length > 0 ? { stepIds: steps.map((step) => step.id) } : {}),
      conditions,
      actions
    }
  })
}
