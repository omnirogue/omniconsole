import { createHash, randomUUID } from 'node:crypto'
import {
  nextOutcomeHandoffRequests,
  resolveNextOutcomeHandoffs,
  type ResolvedNextOutcomeHandoff
} from '../../shared/next-outcome-handoff-request'
import { compileNextStepChain } from '../../shared/next-step-compile'
import { emptyNextStepDraft } from '../../shared/next-step-draft'
import type { SessionChain } from '../../shared/session-chain-types'
import {
  sessionOutcomeConditionKey,
  type SessionOutcomeCommit,
  type SessionOutcomeCondition
} from '../../shared/session-outcome-types'
import type { SessionFollowUpTranscriptSource } from '../../shared/session-follow-up-transcript'
import { readSessionOutcomeHandoffPeople } from './session-outcome-handoff'

export function isNewInferredPersonCondition(
  condition: SessionOutcomeCondition,
  outcomeId: string,
  old: SessionChain | undefined
): boolean {
  return (
    (condition.kind === 'handoff' || (condition.kind === 'review' && !!condition.recipientId)) &&
    !old?.outcomeSet?.outcomes
      .find((outcome) => outcome.id === outcomeId)
      ?.conditions.some(
        (prior) => sessionOutcomeConditionKey(prior) === sessionOutcomeConditionKey(condition)
      )
  )
}

export async function readInferredSessionHandoffs(prompt: string): Promise<{
  handoffs: ResolvedNextOutcomeHandoff[]
  unresolvedRecipients: string[]
  principal?: string
}> {
  if (!nextOutcomeHandoffRequests(prompt).length) {
    return { handoffs: [], unresolvedRecipients: [] }
  }
  const { principal, people } = await readSessionOutcomeHandoffPeople()
  return { principal, ...resolveNextOutcomeHandoffs(prompt, people) }
}

/** New person steps are compiled by the host from its roster and attested prompt, never supplied by AI. */
export function appendInferredSessionHandoffs(args: {
  chain: SessionChain
  input: SessionOutcomeCommit
  old?: SessionChain
  prompt: string
  handoffs: readonly ResolvedNextOutcomeHandoff[]
  transcriptSource?: SessionFollowUpTranscriptSource
}): { chain: SessionChain; input: SessionOutcomeCommit } {
  const steps = [...args.chain.steps]
  const outcomes = args.input.outcomes.map((outcome) => {
    const conditions = outcome.conditions.filter((condition) =>
      isNewInferredPersonCondition(condition, outcome.id, args.old)
    )
    if (!conditions.length) {
      return outcome
    }
    if (outcome.finish !== 'human-handoff' || outcome.actions.length) {
      throw new Error(
        'Put the person handoff in its own human-handoff outcome with no agent actions.'
      )
    }
    const recipients = new Set(conditions.map((condition) => condition.recipientId))
    const addedIds: string[] = []
    for (const recipientId of recipients) {
      const handoff = conditions.find(
        (condition) => condition.kind === 'handoff' && condition.recipientId === recipientId
      )
      const request = args.handoffs.find((entry) => entry.person.id === recipientId)
      if (!handoff || !request) {
        throw new Error('A person review needs an explicit handoff to that resolved recipient.')
      }
      const paths = request.requestedFiles
        ? outcome.conditions
            .filter((condition) => condition.kind === 'file')
            .map((condition) => condition.target)
        : []
      const retainedPaths = new Set(
        args.old?.outcomeSet?.outcomes.flatMap((entry) =>
          entry.conditions
            .filter((condition) => condition.kind === 'file')
            .map((condition) => condition.target)
        ) ?? []
      )
      if (
        request.requestedFiles &&
        (!paths.length ||
          paths.some((path) => !args.prompt.includes(path) && !retainedPaths.has(path)))
      ) {
        throw new Error(
          'Name the exact files to send in the user request or retain their existing committed file conditions.'
        )
      }
      if (request.includeTranscript && !args.transcriptSource) {
        throw new Error(
          'The current source session history is unavailable. Restore its exact session before adding the transcript.'
        )
      }
      const draft = emptyNextStepDraft()
      const compiledId = `chat_handoff_${createHash('sha256')
        .update(JSON.stringify([args.chain.id, outcome.id, recipientId]))
        .digest('hex')
        .slice(0, 32)}`
      draft.handoff = {
        task: null,
        deliverables: { kind: 'files', paths },
        includeSummary: true,
        includeTranscript: request.includeTranscript,
        ...(request.includeTranscript ? { transcriptSource: args.transcriptSource } : {})
      }
      draft.outcomes = [
        {
          id: compiledId,
          instructions: request.instruction,
          steps: [],
          finish: {
            kind: 'person',
            personId: request.person.id,
            personName: request.person.name,
            disposition: request.review ? 'feedback' : 'ownership',
            action: request.review ? 'review' : 'fyi'
          }
        }
      ]
      const compiled = compileNextStepChain({
        draft,
        chainId: args.chain.id,
        workspacePath: args.chain.workspacePath,
        sessionLabel: outcome.title,
        defaultNote: request.instruction,
        now: Date.now(),
        mintStepId: () => randomUUID(),
        mintOperationId: () => randomUUID(),
        cardlessHandoffs: true
      })
      const step = compiled.steps[0]
      if (compiled.problems.length || compiled.steps.length !== 1 || step?.kind !== 'handoff') {
        throw new Error('The explicit person handoff could not be compiled.')
      }
      steps.push({ ...step, outcomeId: outcome.id })
      addedIds.push(step.id)
    }
    return { ...outcome, stepIds: [...(outcome.stepIds ?? []), ...addedIds] }
  })
  return { chain: { ...args.chain, steps }, input: { ...args.input, outcomes } }
}
