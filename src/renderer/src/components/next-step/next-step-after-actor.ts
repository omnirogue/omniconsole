import type { NextStepAfterStep, NextStepAgentRecipient } from '../../../../shared/next-step-draft'

type AgentAfter = Extract<NextStepAfterStep, { kind: 'agent' }>

export function afterStepRecipient(step: AgentAfter): NextStepAgentRecipient {
  return {
    ...step.actor,
    kind: 'agent',
    key: step.key,
    presetId: step.presetId,
    instructions: step.instructions,
    rounds: step.rounds
  }
}

export function recipientAfterStep(
  recipient: NextStepAgentRecipient,
  previous: AgentAfter
): AgentAfter {
  const { kind: _kind, key: _key, presetId, instructions, rounds, ...actor } = recipient
  return { ...previous, actor, presetId: presetId ?? previous.presetId, instructions, rounds }
}
