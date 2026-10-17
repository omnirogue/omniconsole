import { reviewerStepInstructions } from './review-rubrics'
import {
  clampNextStepRounds,
  nextStepReviewRepairProblem,
  nextStepReviewRoundsProblem,
  type NextStepActor,
  type NextStepDraft,
  type NextStepOutcomeDraft,
  type NextStepOutcomeFinish,
  type NextStepProblem
} from './next-step-draft'
import type { SessionActionPresetId } from './session-action-presets'
import type { SessionReviewAssignment, SessionReviewRepairAssignment } from './session-chain-review'
import {
  sessionChainStepOutputDir,
  type SessionChainAgentStep,
  type SessionChainStep
} from './session-chain-types'
import type { SessionChainHandoffStep, SessionFollowUpDeliverables } from './session-follow-up-rule'
import type { NextStepCompileInput } from './next-step-compile'

type AgentStep = (
  input: NextStepCompileInput,
  position: number,
  recipient: NextStepActor & { presetId: SessionActionPresetId | null; instructions: string },
  extra: {
    id?: string
    editorStepId?: string
    outcomeId?: string
    group?: string
    round?: SessionChainAgentStep['round']
    role?: SessionChainAgentStep['role']
    review?: SessionReviewAssignment
    reviewRepair?: SessionReviewRepairAssignment
  }
) => SessionChainAgentStep
type HandoffStep = (
  input: NextStepCompileInput,
  position: number,
  people: readonly { id: string; name: string }[],
  task: { id: string; title: string } | null,
  deliverables: SessionFollowUpDeliverables,
  includeSummary: boolean,
  group: string | undefined,
  review?: boolean,
  id?: string
) => SessionChainHandoffStep

/**
 * Everyone this finish goes to, the named primary first and no duplicates. One person is
 * the ordinary case; several are the reviewers of a review, each addressed in their own right.
 */
export function outcomeFinishPeople(
  finish: Extract<NextStepOutcomeFinish, { kind: 'person' }>
): { id: string; name: string }[] {
  const listed = finish.people ?? []
  const people = [{ id: finish.personId, name: finish.personName }, ...listed]
  return people.filter(
    (person, index) => person.id && people.findIndex((entry) => entry.id === person.id) === index
  )
}

function logicalStepId(...parts: string[]): string {
  return parts
    .join('_')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 120)
}

/** Chain group for one outcome's parallel implementers; never collides with a review round group. */
export function nextOutcomeParallelGroupKey(outcomeId: string, parallelGroup: string): string {
  return `parallel_${outcomeId}_${parallelGroup}`
}

export function nextOutcomeOutputInstruction(
  workspacePath: string,
  chainId: string,
  stepId: string
): string {
  const outputDir = sessionChainStepOutputDir(workspacePath, chainId, stepId)
  return `Write the actual requested result or exact artifact references into ${outputDir}. Finish with ${outputDir}/manifest.md listing the produced files and verification receipts; process exit alone is not completion evidence.`
}

export function stripNextOutcomeOutputInstruction(
  prompt: string,
  workspacePath: string,
  chainId: string,
  stepId: string
): string {
  const suffix = `\n\n${nextOutcomeOutputInstruction(workspacePath, chainId, stepId)}`
  let instructions = prompt
  while (instructions.endsWith(suffix)) {
    instructions = instructions.slice(0, -suffix.length)
  }
  return instructions
}

export function configuredNextStepOutcomes(draft: NextStepDraft): NextStepOutcomeDraft[] {
  return (draft.outcomes ?? []).filter(
    (outcome) => outcome.finish !== null || outcome.steps.length > 0 || outcome.instructions.trim()
  )
}

export function compileNextOutcomeSteps(args: {
  input: NextStepCompileInput
  outcomes: readonly NextStepOutcomeDraft[]
  agentStep: AgentStep
  handoffStep: HandoffStep
  sourceDeliverables: (options: NextStepCompileInput['draft']['handoff']) => {
    deliverables: SessionFollowUpDeliverables
    includeSummary: boolean
  }
}): { steps: SessionChainStep[]; problems: NextStepProblem[] } {
  const { input, outcomes } = args
  const steps: SessionChainStep[] = []
  const problems: NextStepProblem[] = []
  const addAgent = (
    outcomeId: string,
    actor: NextStepActor,
    presetId: SessionActionPresetId,
    instructions: string,
    extra: Parameters<AgentStep>[3]
  ) => {
    const step = args.agentStep(
      input,
      steps.length + 1,
      { ...actor, presetId, instructions },
      { ...extra, outcomeId }
    )
    if (extra.editorStepId) {
      step.editorStepId = extra.editorStepId
    }
    if (!step.review) {
      const outputInstruction = nextOutcomeOutputInstruction(
        input.workspacePath,
        input.chainId,
        step.id
      )
      if (!step.prompt.endsWith(`\n\n${outputInstruction}`)) {
        step.prompt = [step.prompt, outputInstruction].join('\n\n')
      }
    }
    steps.push(step)
    return step
  }
  for (const outcome of outcomes) {
    for (const [index, step] of outcome.steps.entries()) {
      if (
        nextStepReviewRepairProblem(step, outcome.steps[index - 1]) ||
        nextStepReviewRoundsProblem(step, outcome.steps[index + 1])
      ) {
        problems.push({ kind: 'invalid-review-repair', key: step.id })
      }
    }
    let candidateVersion = `${outcome.id}:revision:${outcome.revision ?? 1}`
    for (let index = 0; index < outcome.steps.length; index += 1) {
      const configured = outcome.steps[index]!
      if (configured.kind === 'handoff') {
        if (!configured.actor) {
          problems.push({ kind: 'no-recipients' })
        } else {
          addAgent(outcome.id, configured.actor, configured.presetId, configured.instructions, {
            id: logicalStepId(outcome.id, configured.id),
            editorStepId: configured.id,
            role: outcome.steps[index + 1]?.kind === 'review' ? 'producer' : 'worker',
            ...(configured.parallelGroup
              ? { group: nextOutcomeParallelGroupKey(outcome.id, configured.parallelGroup) }
              : {})
          })
        }
        continue
      }
      if (configured.reviewers.length === 0) {
        problems.push({ kind: 'no-recipients' })
        continue
      }
      const maxRounds = clampNextStepRounds(configured.maxRounds)
      const repair = outcome.steps[index + 1]
      const repairStep = repair?.kind === 'handoff' && repair.reviewRepair ? repair : null
      if (repairStep && !repairStep.actor) {
        problems.push({ kind: 'no-recipients' })
      }
      const groupId = `review_${outcome.id}_${configured.id}`
      for (let round = 1; round <= maxRounds; round += 1) {
        for (const [reviewerIndex, reviewer] of configured.reviewers.entries()) {
          const duplicateIndex =
            configured.reviewers
              .slice(0, reviewerIndex + 1)
              .filter((candidate) => candidate.agent === reviewer.agent).length - 1
          const reviewerId = `${configured.id}:${reviewer.agent}:${duplicateIndex + 1}`
          addAgent(
            outcome.id,
            reviewer,
            'review',
            reviewerStepInstructions(configured.instructions, reviewerIndex),
            {
              id: logicalStepId(
                outcome.id,
                configured.id,
                `reviewer-${reviewer.agent}-${duplicateIndex + 1}`,
                `round-${round}`
              ),
              editorStepId: configured.id,
              role: 'reviewer',
              group: `${groupId}_round_${round}`,
              review: {
                groupId,
                reviewerId,
                round,
                maxRounds,
                candidateVersion,
                ...(!repairStep && configured.repairWithSource && maxRounds > 1
                  ? { repairWithSource: true }
                  : {}),
                ...(configured.adversarial ? { adversarial: true } : {})
              }
            }
          )
        }
        if (round >= maxRounds) {
          break
        }
        if (!repairStep?.actor) {
          if (configured.repairWithSource) {
            continue
          }
          break
        }
        const repairAgent = addAgent(
          outcome.id,
          repairStep.actor,
          repairStep.presetId,
          repairStep.instructions,
          {
            id: logicalStepId(outcome.id, repairStep.id, `repair-after-${round}`),
            editorStepId: repairStep.id,
            role: 'repair',
            reviewRepair: {
              groupId,
              afterRound: round,
              candidateVersion,
              consumptionKey: `${groupId}:repair:${round}:${candidateVersion}`
            }
          }
        )
        candidateVersion = `${candidateVersion}:revised-by:${repairAgent.id}`
      }
      if (repairStep) {
        index += 1
      }
    }
    if (outcome.finish?.kind === 'person') {
      if (!input.draft.handoff.task && !input.cardlessHandoffs) {
        problems.push({ kind: 'no-task' })
        continue
      }
      const source = args.sourceDeliverables(input.draft.handoff)
      const produced = steps.filter(
        (step): step is SessionChainAgentStep =>
          step.kind !== 'handoff' && step.outcomeId === outcome.id && !step.review
      )
      const lastProduced = produced.at(-1)
      const deliverables =
        input.draft.handoff.deliverables !== null
          ? source.deliverables
          : lastProduced
            ? {
                kind: 'manifest' as const,
                manifestPath: `${sessionChainStepOutputDir(input.workspacePath, input.chainId, lastProduced.id)}/manifest.md`
              }
            : source.deliverables
      const people = outcomeFinishPeople(outcome.finish)
      steps.push(
        args.handoffStep(
          input,
          steps.length + 1,
          people,
          input.draft.handoff.task,
          deliverables,
          source.includeSummary,
          undefined,
          outcome.finish.action === 'review',
          logicalStepId(outcome.id, 'person-handoff')
        )
      )
      const last = steps.at(-1)
      if (last?.kind === 'handoff') {
        if (outcome.finish.agentRecipient) {
          // An employee agent session replaces the people list entirely; it is one recipient.
          last.handoff.recipients = []
          last.handoff.agentRecipients = [
            {
              ...outcome.finish.agentRecipient,
              operationId: input.mintOperationId(),
              delivery: 'pending'
            }
          ]
          last.handoff.sourceConversationId =
            input.draft.handoff.sourceConversationId ?? `chain_${input.chainId}`
        }
        last.outcomeId = outcome.id
        last.handoff.disposition =
          outcome.finish.disposition === 'ownership' ? 'ownership-transfer' : 'feedback'
        last.handoff.action = outcome.finish.action
        // The note is what the PERSON wrote to the person receiving the work. The Outcome's
        // own instructions only stand in when they wrote nothing: overwriting a note with the
        // Outcome title delivered the title instead of the message.
        if (!input.draft.note?.trim()) {
          last.handoff.note = outcome.instructions.trim().slice(0, 8192) || last.handoff.note
        }
      }
    }
  }
  return problems.length > 0 ? { steps: [], problems } : { steps, problems }
}
