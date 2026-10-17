import { sessionOutcomeQuotedInstruction } from './session-outcome-inferred-authority'
import { nextOutcomeTeamStepAuthorized } from '../../shared/next-outcome-team-plan-compile'
import { randomUUID } from 'node:crypto'
import type { SessionChain, SessionChainStep } from '../../shared/session-chain-types'
import type { SessionOutcomeCommit } from '../../shared/session-outcome-types'

export function sessionOutcomeStepSignature(step: SessionChainStep): string {
  if (step.kind === 'handoff') {
    const rule = step.handoff
    return JSON.stringify([
      'handoff',
      step.outcomeId,
      rule.taskId,
      rule.action,
      rule.disposition,
      rule.deliverables,
      rule.includeSummary,
      rule.communicationType,
      rule.destinationDirectory,
      rule.transcriptSource,
      rule.sourceConversationId,
      rule.agentRecipients?.map((recipient) => [
        recipient.id,
        recipient.employeeId,
        recipient.projectId
      ]),
      rule.note,
      rule.dueAt,
      rule.recipients.map((recipient) => recipient.employeeId)
    ])
  }
  return JSON.stringify([
    step.agent,
    step.prompt,
    step.presetId,
    step.model,
    step.effort,
    step.accountChoiceId,
    step.outcomeId,
    step.group,
    step.review
      ? [
          step.review.groupId,
          step.review.reviewerId,
          step.review.round,
          step.review.maxRounds,
          step.review.adversarial,
          ...(step.review.repairWithSource ? [true] : [])
        ]
      : null,
    step.reviewRepair
      ? [
          step.reviewRepair.groupId,
          step.reviewRepair.afterRound,
          ...(step.reviewRepair.withSource ? [true] : [])
        ]
      : null,
    ...(step.openrouterCandidates !== undefined ? [step.openrouterCandidates] : [])
  ])
}

const ACTIVE_ATTEMPT_STATES = new Set(['prepared', 'launching', 'running', 'unverifiable'])

function stepAttempts(chain: SessionChain | undefined, stepId: string) {
  return (
    chain?.outcomeSet?.attempts.filter((attempt) => attempt.actionId === `step_${stepId}`) ?? []
  )
}

function stepIsUncertain(chain: SessionChain | undefined, step: SessionChainStep): boolean {
  if (stepAttempts(chain, step.id).some((attempt) => ACTIVE_ATTEMPT_STATES.has(attempt.state))) {
    return true
  }
  return (
    step.kind === 'handoff' &&
    [...step.handoff.recipients, ...(step.handoff.agentRecipients ?? [])].some(
      (recipient) => recipient.delivery === 'sending'
    )
  )
}

function stepHasReceipt(chain: SessionChain | undefined, step: SessionChainStep): boolean {
  if (step.kind === 'handoff') {
    return (
      step.status === 'delivered' ||
      [...step.handoff.recipients, ...(step.handoff.agentRecipients ?? [])].some(
        (recipient) => recipient.delivery === 'sent'
      )
    )
  }
  return (
    step.status === 'launched' ||
    stepAttempts(chain, step.id).some((attempt) => attempt.state === 'completed')
  )
}

/** Preserve completed/active receipts for unchanged steps; changed work gets a fresh durable identity. */
export function reconcileSessionOutcomeSteps(
  base: SessionChain,
  old: SessionChain | undefined,
  input: SessionOutcomeCommit,
  authorityInstruction?: string
): { steps: SessionChainStep[]; input: SessionOutcomeCommit } {
  const canonicalAmendment = input.source === 'user' && Boolean(old?.outcomeSet?.workflow)
  const refreshReviews = new Set<string>()
  if (canonicalAmendment) {
    const generations = [...(old!.outcomeSet!.workflowHistory ?? []), old!.outcomeSet!.workflow!]
    for (const stage of generations.flatMap((workflow) => workflow.stages)) {
      const producerChanged = stage.stepIds.some((id) => {
        const previous = old!.steps.find((step) => step.id === id)
        const current = base.steps.find((step) => step.id === id)
        return (
          previous &&
          current &&
          previous.kind !== 'handoff' &&
          !previous.review &&
          !previous.reviewRepair &&
          sessionOutcomeStepSignature(previous) !== sessionOutcomeStepSignature(current)
        )
      })
      if (producerChanged) {
        for (const id of stage.stepIds) {
          const previous = old!.steps.find((step) => step.id === id)
          if (previous?.kind !== 'handoff' && (previous?.review || previous?.reviewRepair)) {
            refreshReviews.add(id)
          }
        }
      }
    }
  }
  const mapping = new Map<string, string>()
  const consumed = new Set<string>()
  const steps = base.steps.map((step) => {
    const direct = old?.steps.find((entry) => entry.id === step.id)
    const previous =
      direct ??
      old?.steps.find(
        (entry) =>
          !consumed.has(entry.id) &&
          sessionOutcomeStepSignature(entry) === sessionOutcomeStepSignature(step)
      )
    if (previous) {
      consumed.add(previous.id)
      mapping.set(step.id, previous.id)
    }
    if (
      previous &&
      !refreshReviews.has(previous.id) &&
      sessionOutcomeStepSignature(previous) === sessionOutcomeStepSignature(step)
    ) {
      return structuredClone(previous)
    }
    // Why: the one authorization that lets an AI commit author a team's shape — the user's
    // launch-time "Plan the team" consent, re-checked here per step against the attested prompt.
    const teamAuthorized = Boolean(
      input.teamPlanning && nextOutcomeTeamStepAuthorized(step, base, authorityInstruction)
    )
    if (
      !teamAuthorized &&
      input.source === 'ai' &&
      step.kind !== 'handoff' &&
      step.review?.repairWithSource &&
      (!previous ||
        previous.kind === 'handoff' ||
        !previous.review?.repairWithSource ||
        step.review.maxRounds > previous.review.maxRounds)
    ) {
      throw new Error(
        'AI cannot add original-builder repair authority or increase its review rounds.'
      )
    }
    if (
      input.source === 'ai' &&
      (step.kind === 'handoff' ||
        !(sessionOutcomeQuotedInstruction(step.prompt, authorityInstruction) || teamAuthorized))
    ) {
      throw new Error(
        'AI cannot add or rewrite steps outside its attested source task instructions.'
      )
    }
    // Why: a group or review round launches agents side by side; only the person authors that,
    // or the team they consented at launch to have planned — never an unconsented AI suggestion.
    if (
      !teamAuthorized &&
      input.source === 'ai' &&
      step.kind !== 'handoff' &&
      (step.group || step.review || step.reviewRepair)
    ) {
      throw new Error(
        'AI cannot add parallel groups or review rounds; they stay user-chosen under Next.'
      )
    }
    if (
      previous &&
      stepIsUncertain(old, previous) &&
      (!canonicalAmendment || previous.kind === 'handoff')
    ) {
      throw new Error('This step may already be in progress. Resolve it before editing it.')
    }
    if (
      previous &&
      stepHasReceipt(old, previous) &&
      (!canonicalAmendment || previous.kind === 'handoff')
    ) {
      throw new Error(
        'This step already ran. Add a new step for changed work; its receipt was kept.'
      )
    }
    const id = canonicalAmendment && previous ? randomUUID() : (previous?.id ?? step.id)
    mapping.set(step.id, id)
    if (step.kind !== 'handoff') {
      return {
        ...step,
        id,
        status: 'queued' as const,
        replacedStepId: canonicalAmendment && previous ? previous.id : undefined,
        ...(canonicalAmendment && previous
          ? {
              editorStepId:
                previous.kind !== 'handoff' ? (previous.editorStepId ?? previous.id) : previous.id
            }
          : {}),
        launchedPaneKey: undefined,
        launchedAt: undefined
      }
    }
    return {
      ...step,
      id,
      status: 'queued' as const,
      handoff: {
        revision: (previous?.kind === 'handoff' ? previous.handoff.revision : 0) + 1,
        taskId: step.handoff.taskId,
        taskTitle: step.handoff.taskTitle,
        sessionLabel: step.handoff.sessionLabel,
        action: step.handoff.action,
        disposition: step.handoff.disposition,
        deliverables: step.handoff.deliverables,
        includeSummary: step.handoff.includeSummary,
        communicationType: step.handoff.communicationType,
        destinationDirectory: step.handoff.destinationDirectory,
        transcriptSource: step.handoff.transcriptSource,
        sourceConversationId: step.handoff.sourceConversationId,
        ...(step.handoff.agentRecipients?.length
          ? {
              agentRecipients: step.handoff.agentRecipients.map(
                ({ id, name, kind, employeeId, projectId }) => ({
                  id,
                  name,
                  kind,
                  employeeId,
                  projectId,
                  operationId: randomUUID(),
                  delivery: 'pending' as const
                })
              )
            }
          : {}),
        note: step.handoff.note,
        ...(step.handoff.noteAuthored ? { noteAuthored: true as const } : {}),
        dueAt: step.handoff.dueAt,
        savedAt: Date.now(),
        recipients: step.handoff.recipients.map((recipient) => ({
          employeeId: recipient.employeeId,
          name: recipient.name,
          operationId: randomUUID(),
          delivery: 'pending' as const
        }))
      }
    }
  })
  const retainedReceipts: SessionChainStep[] = []
  for (const previous of old?.steps ?? []) {
    if (consumed.has(previous.id)) {
      continue
    }
    if (stepIsUncertain(old, previous) && (!canonicalAmendment || previous.kind === 'handoff')) {
      throw new Error('This step may already be in progress. Resolve it before removing it.')
    }
    retainedReceipts.push(structuredClone(previous))
  }
  return {
    steps: [...steps, ...retainedReceipts],
    input: {
      ...input,
      outcomes: input.outcomes.map((outcome) => ({
        ...outcome,
        ...(outcome.stepIds
          ? {
              stepIds: [
                ...new Set([
                  ...outcome.stepIds.map((id) => mapping.get(id) ?? id),
                  ...retainedReceipts
                    .filter((step) =>
                      old?.outcomeSet?.outcomes
                        .find((entry) => entry.id === outcome.id)
                        ?.stepIds?.includes(step.id)
                    )
                    .map((step) => step.id)
                ])
              ]
            }
          : {})
      }))
    }
  }
}
