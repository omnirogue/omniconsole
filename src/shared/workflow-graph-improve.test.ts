import { describe, expect, it } from 'vitest'
import { modelLineage } from './model-lineage'
import { fallbackJudges, fastImproveModels } from './workflow-graph-improve'

describe('Improve stand-in judges', () => {
  it('judges one model working alone by a family other than its own', () => {
    const all = ['claude', 'codex', 'grok', 'gemini'] as const
    for (const maker of [
      { route: 'claude', model: 'opus' },
      { route: 'codex', model: 'gpt-6-astra' },
      { route: 'grok' }
    ] as const) {
      const [judge] = fallbackJudges({ mode: 'single', ...maker }, all)
      expect(modelLineage(judge!.route, judge!.model)).not.toBe(
        modelLineage(maker.route, 'model' in maker ? maker.model : undefined)
      )
    }
  })

  it('adds a judge from outside the makers when those that may judge are of one family', () => {
    // Gemini never judges, so Haiku alone would rank its own family's work against Flash's.
    const available = ['claude', 'gemini', 'grok'] as const
    expect(fallbackJudges(fastImproveModels(available), available)).toEqual([
      { route: 'claude', model: 'claude-haiku-5-5' },
      { route: 'grok' }
    ])
    // Two families that may judge already give every maker a judge of another family.
    const three = ['claude', 'gemini', 'codex'] as const
    expect(fallbackJudges(fastImproveModels(three), three)).toEqual([
      { route: 'claude', model: 'claude-haiku-5-5' },
      { route: 'codex', model: 'gpt-6-luna' }
    ])
    // With no other family here, the lineup is as it was.
    const two = ['claude', 'gemini'] as const
    expect(fallbackJudges(fastImproveModels(two), two)).toEqual([
      { route: 'claude', model: 'claude-haiku-5-5' }
    ])
  })
})
