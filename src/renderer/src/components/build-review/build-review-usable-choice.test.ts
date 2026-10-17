import { describe, expect, it, vi } from 'vitest'
import type { CatalogModel } from '../../../../shared/agent-session-option-catalog'
import { reconcileReviewerSeats, type ReviewerHostCatalog } from './build-review-seat-host-pinning'
import { usableAgentChoice } from './build-review-usable-choice'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, english: string) => english }))

const effort = (values: string[]): CatalogModel['options'] => [
  {
    id: 'effort',
    label: 'Effort',
    category: 'thought_level',
    kind: {
      type: 'select',
      choices: values.map((value) => ({ value, label: value })),
      defaultValue: values[0]!
    },
    apply: {}
  }
]
const fable: CatalogModel = { id: 'fable', label: 'Fable 5.1', options: effort(['max']) }
const opus: CatalogModel = { id: 'opus', label: 'Opus', options: effort(['high', 'max']) }
const sonnet: CatalogModel = { id: 'sonnet', label: 'Sonnet', options: effort(['high']) }

/** Claude as the host reads it while its Fable week is spent. */
const claude = {
  id: 'claude' as const,
  models: [opus, sonnet],
  modelsProbed: true,
  unavailableModels: [fable],
  defaultModelUnavailable: true
}

describe('usableAgentChoice', () => {
  it('launches the next usable model instead of a spent "Agent default"', () => {
    expect(usableAgentChoice({ agent: 'claude' }, [claude])).toEqual({
      agent: 'claude',
      model: 'opus'
    })
    // An effort the new model also has is kept.
    expect(usableAgentChoice({ agent: 'claude', model: 'fable', effort: 'max' }, [claude])).toEqual(
      {
        agent: 'claude',
        model: 'opus',
        effort: 'max'
      }
    )
  })

  it('prefers the usable model the host names as its default, and drops a foreign effort', () => {
    const named = { ...claude, models: [opus, { ...sonnet, isDefault: true }] }
    expect(usableAgentChoice({ agent: 'claude', model: 'fable', effort: 'max' }, [named])).toEqual({
      agent: 'claude',
      model: 'sonnet'
    })
  })

  it('leaves every other choice as the person made it', () => {
    const choice = { agent: 'claude', model: 'sonnet' }
    expect(usableAgentChoice(choice, [claude])).toBe(choice)
    const unspent = { ...claude, unavailableModels: undefined, defaultModelUnavailable: undefined }
    const agentDefault = { agent: 'claude' }
    expect(usableAgentChoice(agentDefault, [unspent])).toBe(agentDefault)
    const codex = { agent: 'codex' }
    expect(usableAgentChoice(codex, [claude])).toBe(codex)
  })
})

describe('reviewer seats and spent models', () => {
  it('moves a chosen reviewer off a spent model instead of leaving it to fail', () => {
    const host: ReviewerHostCatalog = { agents: [claude], loading: false }
    const [seat] = reconcileReviewerSeats(
      [{ id: 1, choice: { agent: 'claude', model: 'fable', effort: 'max' }, chosen: true }],
      host
    )
    expect(seat!.choice).toEqual({ agent: 'claude', model: 'opus', effort: 'max' })
    // A chosen model the host simply does not list is still left for the problem line.
    const [unlisted] = reconcileReviewerSeats(
      [{ id: 1, choice: { agent: 'claude', model: 'haiku' }, chosen: true }],
      host
    )
    expect(unlisted!.choice).toEqual({ agent: 'claude', model: 'haiku' })
  })
})
