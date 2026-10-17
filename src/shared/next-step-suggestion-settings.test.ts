import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from './constants'
import { resolveAdPauses } from './next-step-ad-pauses'
import { NEXT_STEP_KEEP_GOING_DEFAULT_PUSH_PROMPT } from './next-step-keep-going'
import {
  keepGoingDefaultPushPrompt,
  keepGoingDefaultRounds,
  nextStepJevSettings,
  normalizeNextStepSuggestionSettings
} from './next-step-suggestion-settings'

describe('normalizeNextStepSuggestionSettings', () => {
  it('defaults on, and only an explicit false turns it off', () => {
    expect(getDefaultSettings('/home/me').nextStepSuggestions).toEqual({ enabled: true })
    expect(normalizeNextStepSuggestionSettings(undefined)).toEqual({ enabled: true })
    expect(normalizeNextStepSuggestionSettings('yes')).toEqual({ enabled: true })
    expect(normalizeNextStepSuggestionSettings({ enabled: 0 })).toEqual({ enabled: true })
    expect(normalizeNextStepSuggestionSettings({ enabled: false })).toEqual({ enabled: false })
  })

  it('keeps a known agent and a bounded model, and drops anything else', () => {
    expect(
      normalizeNextStepSuggestionSettings({ enabled: true, agent: 'codex', model: ' gpt-5.4 ' })
    ).toEqual({ enabled: true, agent: 'codex', model: 'gpt-5.4' })
    expect(
      normalizeNextStepSuggestionSettings({ agent: 'not-an-agent', model: 'x'.repeat(500) })
    ).toEqual({ enabled: true })
  })

  it('keeps a whole keep-going round count from 1 to 25 and drops anything else', () => {
    expect(normalizeNextStepSuggestionSettings({ keepGoingMaxRounds: 25 })).toEqual({
      enabled: true,
      keepGoingMaxRounds: 25
    })
    for (const bad of [0, 26, 2.5, '3', null]) {
      expect(normalizeNextStepSuggestionSettings({ keepGoingMaxRounds: bad })).toEqual({
        enabled: true
      })
    }
    expect(keepGoingDefaultRounds(normalizeNextStepSuggestionSettings(undefined))).toBe(10)
    expect(keepGoingDefaultRounds({ enabled: true, keepGoingMaxRounds: 7 })).toBe(7)
  })

  it('keeps a known ad-pause choice, absent meaning allowed, and the session’s choice wins', () => {
    expect(normalizeNextStepSuggestionSettings({ adPauses: 'ask-first' })).toEqual({
      enabled: true,
      adPauses: 'ask-first'
    })
    for (const bad of ['never', true, null]) {
      expect(normalizeNextStepSuggestionSettings({ adPauses: bad })).toEqual({ enabled: true })
    }
    expect(resolveAdPauses(undefined, undefined)).toBe('allowed')
    expect(resolveAdPauses('ask-first', undefined)).toBe('ask-first')
    expect(resolveAdPauses('ask-first', 'allowed')).toBe('allowed')
    expect(resolveAdPauses('allowed', 'ask-first')).toBe('ask-first')
  })

  it('reads the JEV switches, each on unless explicitly off', () => {
    expect(nextStepJevSettings(normalizeNextStepSuggestionSettings(undefined))).toEqual({
      rank: true,
      risk: true,
      doneness: true
    })
    expect(normalizeNextStepSuggestionSettings({ jev: { rank: false, risk: 0 } })).toEqual({
      enabled: true,
      jev: { rank: false, risk: true, doneness: true }
    })
    expect(normalizeNextStepSuggestionSettings({ jev: 'off' })).toEqual({ enabled: true })
  })

  it('keeps a known keep-going mode and a trimmed push prompt capped at 2,000 characters', () => {
    expect(
      normalizeNextStepSuggestionSettings({
        keepGoingDefaultMode: 'push-for-better',
        keepGoingPushPrompt: '  Sharper, please.  '
      })
    ).toEqual({
      enabled: true,
      keepGoingDefaultMode: 'push-for-better',
      keepGoingPushPrompt: 'Sharper, please.'
    })
    expect(
      normalizeNextStepSuggestionSettings({
        keepGoingDefaultMode: 'autopilot',
        keepGoingPushPrompt: '  '
      })
    ).toEqual({ enabled: true })
    const long = normalizeNextStepSuggestionSettings({ keepGoingPushPrompt: 'x'.repeat(3000) })
    expect(long.keepGoingPushPrompt).toHaveLength(2000)
    expect(keepGoingDefaultPushPrompt({ enabled: true })).toBe(
      NEXT_STEP_KEEP_GOING_DEFAULT_PUSH_PROMPT
    )
    expect(keepGoingDefaultPushPrompt({ enabled: true, keepGoingPushPrompt: 'More.' })).toBe(
      'More.'
    )
  })
})
