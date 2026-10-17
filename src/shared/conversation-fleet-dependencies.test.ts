import { describe, expect, it } from 'vitest'
import { compileNextStepChain } from './next-step-compile'
import { emptyNextStepDraft, type NextStepDraft } from './next-step-draft'
import { conversationFleetStageDependencies } from './conversation-fleet-dependencies'

function dependencies(draft: NextStepDraft): string[][] {
  const compiled = compileNextStepChain({
    draft,
    chainId: 'workflow-123',
    workspacePath: '.',
    sessionLabel: 'Source',
    defaultNote: 'Next',
    now: 0,
    cardlessHandoffs: true,
    mintOperationId: () => 'operation-123',
    mintStepId: (index) => `step-${index}`
  })
  const keys = new Map(
    compiled.steps.map((step) => [
      step.id,
      step.kind === 'handoff'
        ? step.handoff.recipients.map((_, index) => `${step.id}-person-${index + 1}`)
        : [step.id]
    ])
  )
  return compiled.steps.map((_, index) =>
    conversationFleetStageDependencies(compiled.steps, index, keys)
  )
}

function plan(): NextStepDraft {
  return {
    ...emptyNextStepDraft(),
    recipients: [
      {
        key: 'first',
        kind: 'agent',
        agent: 'codex',
        presetId: 'implement',
        instructions: 'Implement.',
        rounds: 1
      }
    ]
  }
}

describe('fleet delivery dependency order', () => {
  it('keeps the AI artifact source while waiting for intervening delivery receipts', () => {
    const draft = plan()
    draft.after = [
      { key: 'person-one', kind: 'person', id: 'emp_one', name: 'One' },
      { key: 'person-two', kind: 'person', id: 'emp_two', name: 'Two' },
      {
        key: 'review',
        kind: 'agent',
        actor: { agent: 'codex' },
        presetId: 'review',
        instructions: 'Review.',
        rounds: 1
      }
    ]
    expect(dependencies(draft)).toEqual([
      [],
      ['step-1'],
      ['step-1', 'step-2-person-1'],
      ['step-1', 'step-3-person-1']
    ])
  })

  it('starts initial people with the agent fanout and waits for every receipt before the next stage', () => {
    const draft = plan()
    draft.recipients.push({ key: 'person-one', kind: 'person', id: 'emp_one', name: 'One' })
    draft.recipients.push({ key: 'person-two', kind: 'person', id: 'emp_two', name: 'Two' })
    draft.after = [
      {
        key: 'review',
        kind: 'agent',
        actor: { agent: 'codex' },
        presetId: 'review',
        instructions: 'Review.',
        rounds: 1
      }
    ]
    expect(dependencies(draft)).toEqual([[], [], ['step-1', 'step-2-person-1', 'step-2-person-2']])
  })
})
