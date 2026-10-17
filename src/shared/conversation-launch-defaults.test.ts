import { describe, expect, it } from 'vitest'
import { normalizeConversationLaunchDefaults } from './conversation-launch-defaults'

describe('conversation launch defaults', () => {
  it('accepts only known agents and bounded plain strings', () => {
    expect(
      normalizeConversationLaunchDefaults({
        claude: { model: ' sonnet ', effort: ' high ', extra: true },
        codex: { model: 'x'.repeat(201), effort: '\ninvalid' },
        unknown: { model: 'foo' },
        grok: [],
        omp: null
      })
    ).toEqual({ claude: { model: 'sonnet', effort: 'high' } })
  })
  it('retains an effort for a later explicit model selection', () => {
    expect(normalizeConversationLaunchDefaults({ claude: { effort: 'high' } })).toEqual({
      claude: { effort: 'high' }
    })
  })
  it('rejects non-record values', () => {
    for (const value of [null, undefined, false, 'claude', []]) {
      expect(normalizeConversationLaunchDefaults(value)).toEqual({})
    }
  })
})
