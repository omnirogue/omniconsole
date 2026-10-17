import { describe, expect, it } from 'vitest'
import {
  catalogModelsFromDiscovery,
  effortChoicesFor,
  modelChoicesFor,
  resolveBuildReviewModels
} from './build-review-model-options'

describe('build-review model options', () => {
  it('falls back to the static seed until the host answers', () => {
    const models = resolveBuildReviewModels('claude', null)
    expect(models.map((model) => model.id)).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
    // ultracode rides on every Claude model that takes xhigh (claude-ultracode-effort.ts).
    expect(effortChoicesFor('claude', models, 'opus').map((choice) => choice.value)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultracode'
    ])
  })

  it('lets a probe replace the seed so retired ids disappear and new ones appear', () => {
    const discovered = catalogModelsFromDiscovery('codex', [
      {
        id: 'gpt-6-astra',
        label: 'GPT-6-Astra',
        thinkingLevels: [
          { id: 'low', label: 'Low' },
          { id: 'medium', label: 'Medium' },
          { id: 'high', label: 'High' }
        ],
        defaultThinkingLevel: 'medium'
      },
      { id: 'gpt-5.5', label: 'GPT-5.5' }
    ])
    const models = resolveBuildReviewModels('codex', discovered)
    expect(modelChoicesFor(models).map((choice) => choice.value)).toEqual([
      'gpt-6-astra',
      'gpt-5.5'
    ])
    expect(effortChoicesFor('codex', models, 'gpt-6-astra').map((choice) => choice.value)).toEqual([
      'low',
      'medium',
      'high'
    ])
    // A probed row without levels borrows the seed's menu for that id.
    expect(effortChoicesFor('codex', models, 'gpt-5.5').map((choice) => choice.value)).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh'
    ])
  })

  it('derives Claude effort levels from the CLI model list', () => {
    const discovered = catalogModelsFromDiscovery('claude', [
      {
        id: 'fable[1m]',
        label: 'Fable',
        thinkingLevels: [
          { id: 'high', label: 'High' },
          { id: 'max', label: 'Max' }
        ]
      },
      { id: 'haiku', label: 'Haiku', thinkingLevels: [] }
    ])
    const models = resolveBuildReviewModels('claude', discovered)
    expect(effortChoicesFor('claude', models, 'fable[1m]').map((choice) => choice.value)).toEqual([
      'high',
      'max'
    ])
    expect(effortChoicesFor('claude', models, 'haiku')).toEqual([])
  })

  it('offers the generic effort menu for an id the host never listed', () => {
    const models = resolveBuildReviewModels('claude', null)
    expect(effortChoicesFor('claude', models, 'claude-opus-5').length).toBeGreaterThan(0)
    expect(effortChoicesFor('devin', [], 'anything')).toEqual([])
    expect(resolveBuildReviewModels('devin', null)).toEqual([])
  })
})
