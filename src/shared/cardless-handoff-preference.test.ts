import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from './constants'
import { cardlessHandoffsEnabledByPreference } from './cardless-handoff-preference'

describe('cardless handoff preference', () => {
  it('enables handoffs without a task for a new production profile', () => {
    expect(getDefaultSettings('/home/person').experimentalCardlessHandoffs).toBe(true)
  })

  it.each([undefined, null, {}, { experimentalCardlessHandoffs: true }])(
    'uses the production default unless a profile opts out: %j',
    (settings) => expect(cardlessHandoffsEnabledByPreference(settings)).toBe(true)
  )

  it('ignores an explicit false when saved settings overlay the defaults since cardless handoffs are permanent', () => {
    const settings = {
      ...getDefaultSettings('/home/person'),
      experimentalCardlessHandoffs: false
    }
    expect(cardlessHandoffsEnabledByPreference(settings)).toBe(true)
  })
})
