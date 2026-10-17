import { describe, expect, it } from 'vitest'
import { compileNextStepChain } from './next-step-compile'
import {
  emptyNextStepDraft,
  type NextStepDraft,
  type NextStepAgentRecipient
} from './next-step-draft'
import { normalizeSessionChain } from './session-chain-types'
const agent: NextStepAgentRecipient = {
  kind: 'agent',
  key: 'a',
  agent: 'claude',
  presetId: 'review',
  instructions: '',
  rounds: 1
}
function compile(patch: Partial<NextStepDraft>) {
  return compileNextStepChain({
    draft: { ...emptyNextStepDraft(), ...patch },
    chainId: 'chain',
    workspacePath: '/w',
    sessionLabel: 'Build',
    defaultNote: 'Work',
    now: 1,
    mintStepId: String,
    mintOperationId: () => 'op',
    cardlessHandoffs: true
  })
}
describe('next step levels', () => {
  it('requires exactly one handoff recipient', () => {
    expect(compile({ mode: 'handoff', recipients: [agent] }).problems).toEqual([])
    expect(
      compile({ mode: 'handoff', recipients: [agent, { ...agent, key: 'b' }] }).problems
    ).toContainEqual({ kind: 'handoff-needs-one-recipient' })
  })
  it('fans three reviewers out together', () => {
    const { steps, problems } = compile({
      mode: 'review',
      recipients: ['a', 'b', 'c'].map((key) => ({ ...agent, key }))
    })
    expect(problems).toEqual([])
    expect(steps).toHaveLength(3)
    expect(steps.map((step) => step.group)).toEqual(['g1', 'g1', 'g1'])
  })
  it('compiles agent to person to done and preserves the ending through normalization', () => {
    const { steps, problems } = compile({
      recipients: [agent],
      after: [{ kind: 'person', key: 'p', id: 'sal', name: 'Sal', level: 2 }],
      end: 'done'
    })
    expect(problems).toEqual([])
    expect(steps[1]).toMatchObject({ kind: 'handoff' })
    expect(
      normalizeSessionChain({
        id: 'c',
        workspacePath: '/w',
        worktreeId: 'w',
        sourcePaneKey: 'p',
        sourceRowKey: 'r',
        steps,
        end: 'done',
        placement: 'ssh:remote'
      })
    ).toMatchObject({ end: 'done', placement: 'ssh:remote' })
  })
  it('carries the review request to people at the first and later review levels', () => {
    const person = { kind: 'person' as const, key: 'sal', id: 'sal', name: 'Sal' }
    expect(compile({ mode: 'review', recipients: [person] }).steps[0]).toMatchObject({
      handoff: { action: 'review' }
    })
    const after = [person, { ...person, key: 'second', id: 'second' }].map((entry) => ({
      ...entry,
      level: 2
    }))
    expect(compile({ recipients: [agent], after }).steps.slice(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ handoff: expect.objectContaining({ action: 'review' }) })
      ])
    )
  })

  it('records a later-level review as a review, not a handoff of ownership', () => {
    const person = { kind: 'person' as const, key: 'sal', id: 'sal', name: 'Sal', level: 2 }
    expect(
      compile({ recipients: [agent], after: [{ ...person, action: 'review' }] }).steps[1]
    ).toMatchObject({ handoff: { action: 'review' } })
    const handed = compile({ recipients: [agent], after: [person] }).steps[1]
    expect(handed).toMatchObject({ kind: 'handoff' })
    expect(handed && 'handoff' in handed ? handed.handoff.action : 'unset').toBeUndefined()
  })

  it('allows five levels and rejects a sixth', () => {
    const after = [2, 3, 4, 5].map((level) => ({
      kind: 'person' as const,
      key: `p${level}`,
      id: 'sal',
      name: 'Sal',
      level
    }))
    expect(compile({ recipients: [agent], after }).problems).toEqual([])
    expect(
      compile({ recipients: [agent], after: [...after, { ...after[0]!, level: 6 }] }).problems
    ).toContainEqual({ kind: 'too-many-levels' })
  })
  it('groups a later review level and shares its predecessors', () => {
    const after = ['a', 'b', 'c'].map((key) => ({
      kind: 'agent' as const,
      key,
      actor: { agent: 'codex' as const },
      presetId: 'review' as const,
      instructions: '',
      rounds: 3,
      level: 2
    }))
    const result = compile({ recipients: [agent], after })
    expect(result.steps.map((step) => step.group)).toEqual([undefined, 'g2', 'g2', 'g2'])
  })
})
