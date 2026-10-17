import { describe, expect, it } from 'vitest'
import type {
  NextStepSuggestion,
  NextStepSuggestionSet
} from '../../../../shared/next-step-suggestions'
import { nextStepsAnswerOf } from './next-steps-answer'

const option = (id: string, over: Partial<NextStepSuggestion> = {}): NextStepSuggestion => ({
  id,
  title: `Option ${id}`,
  prompt: `Please go ahead with this option you offered: Option ${id}`,
  risk: 'safe',
  kind: 'continue',
  offered: true,
  optionGroup: 'menu-1',
  ...over
})
const parsed = (suggestions: NextStepSuggestion[]): NextStepSuggestionSet => ({
  id: 'parsed-1',
  conversation: { worktreeId: 'wt', paneKey: 'tab-1:leaf-1', kind: 'pty' },
  worktreeId: 'wt',
  turnKey: 't1',
  origin: 'parsed',
  createdAt: 10,
  status: 'pending',
  suggestions
})
const ungrouped = (id: string): NextStepSuggestion => {
  const { optionGroup: _group, ...step } = option(id)
  return step
}

describe('nextStepsAnswerOf', () => {
  it('is a checklist for a menu the reply offered, whatever its length', () => {
    const steps = Array.from({ length: 10 }, (_, at) => option(`s${at + 1}`))
    const answer = nextStepsAnswerOf(parsed(steps))
    expect(answer?.kind).toBe('choose')
    expect(answer && 'steps' in answer ? answer.steps.map((step) => step.id) : []).toEqual(
      steps.map((step) => step.id)
    )
  })

  it('is a checklist for a two-option menu too, not one button each', () => {
    expect(nextStepsAnswerOf(parsed([option('s1'), option('s2')]))?.kind).toBe('choose')
  })

  it('pre-ticks the options the reply named, never a risky one', () => {
    const answer = nextStepsAnswerOf(
      parsed([
        option('s1', { preselected: true }),
        option('s2'),
        option('s3', { preselected: true, risk: 'risky' }),
        option('s4', { preselected: true })
      ])
    )
    expect(answer?.kind === 'choose' ? answer.preselectedIds : null).toEqual(['s1', 's4'])
  })

  it('keeps the risky option on the list for the person to tick', () => {
    const answer = nextStepsAnswerOf(
      parsed([option('s1'), option('s2', { risk: 'risky', preselected: true })])
    )
    expect(answer?.kind === 'choose' ? answer.steps.map((step) => step.id) : null).toEqual([
      's1',
      's2'
    ])
  })

  it('leaves the listed next steps out of the checklist', () => {
    const { offered: _offered, optionGroup: _group, ...listed } = option('s3')
    const answer = nextStepsAnswerOf(parsed([option('s1'), option('s2'), listed]))
    expect(answer?.kind === 'choose' ? answer.steps.map((step) => step.id) : null).toEqual([
      's1',
      's2'
    ])
  })

  it('keeps one button per option for offers from different menus or none', () => {
    expect(
      nextStepsAnswerOf(parsed([option('s1'), option('s2', { optionGroup: 'menu-2' })]))?.kind
    ).toBe('options')
    expect(nextStepsAnswerOf(parsed([ungrouped('s1'), ungrouped('s2')]))?.kind).toBe('options')
  })

  it('keeps a single "Yes" for one proposal, grouped or not', () => {
    expect(nextStepsAnswerOf(parsed([option('s1')]))?.kind).toBe('yes')
    expect(nextStepsAnswerOf(parsed([ungrouped('s1')]))?.kind).toBe('yes')
  })

  it('leaves a long ungrouped offer to the tray', () => {
    const steps = ['s1', 's2', 's3', 's4', 's5'].map(ungrouped)
    expect(nextStepsAnswerOf(parsed(steps))).toBeNull()
  })

  it('answers only a pending set read from the reply', () => {
    const menu = parsed([option('s1'), option('s2')])
    expect(nextStepsAnswerOf({ ...menu, origin: 'ai' })).toBeNull()
    expect(nextStepsAnswerOf({ ...menu, status: 'accepted' })).toBeNull()
    expect(nextStepsAnswerOf(null)).toBeNull()
  })
})
