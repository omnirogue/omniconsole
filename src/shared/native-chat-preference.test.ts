import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from './constants'
import { nativeChatEnabledByPreference } from './native-chat-preference'

describe('native chat preference', () => {
  it('enables Chat UI for a new profile', () => {
    expect(getDefaultSettings('/home/person').experimentalNativeChat).toBe(true)
  })

  it.each([undefined, null, {}, { experimentalNativeChat: true }])(
    'enables conversation views without an experimental opt-in: %j',
    (settings) => expect(nativeChatEnabledByPreference(settings)).toBe(true)
  )

  it('preserves a saved opt-out over the new default', () => {
    const settings = { ...getDefaultSettings('/home/person'), experimentalNativeChat: false }
    expect(nativeChatEnabledByPreference(settings)).toBe(false)
  })
})
