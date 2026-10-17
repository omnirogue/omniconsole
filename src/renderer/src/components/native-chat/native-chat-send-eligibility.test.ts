import { describe, expect, it } from 'vitest'
import {
  deriveNativeChatCanSend,
  deriveNativeChatSessionOptionParityHold,
  shouldChatTakeOverMobileSurface
} from './native-chat-send-eligibility'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'
import type { SessionEffortParity } from '../../../../shared/session-effort-parity'

function effortRow(parity?: SessionEffortParity): SessionOptionDescriptor {
  return {
    id: 'effort',
    label: 'Effort',
    category: 'thought_level',
    kind: { type: 'select', currentValue: 'high', choices: [{ value: 'high', label: 'High' }] },
    valueSource: 'reported',
    ...(parity ? { parity } : {}),
    settable: true
  }
}

describe('deriveNativeChatCanSend', () => {
  it('blocks sends when a mobile client holds the pty (presence-lock active)', () => {
    expect(deriveNativeChatCanSend({ kind: 'mobile', clientId: 'phone-1' })).toBe(false)
  })

  it('allows sends when the desktop drives the pty', () => {
    expect(deriveNativeChatCanSend({ kind: 'desktop' })).toBe(true)
  })

  it('allows sends when the pty is idle', () => {
    expect(deriveNativeChatCanSend({ kind: 'idle' })).toBe(true)
  })

  it('treats an unresolved driver (null/undefined) as unlocked', () => {
    expect(deriveNativeChatCanSend(null)).toBe(true)
    expect(deriveNativeChatCanSend(undefined)).toBe(true)
  })
})

describe('deriveNativeChatSessionOptionParityHold', () => {
  it('holds the send while the session runs at another effort than requested', () => {
    expect(
      deriveNativeChatSessionOptionParityHold([
        effortRow({
          state: 'mismatch',
          reason: 'effort-differs',
          requested: { effort: 'xhigh' },
          applied: { effort: 'high' }
        })
      ])
    ).toBe(true)
  })

  it('holds the send when the requested effort is refused rather than clamped', () => {
    expect(
      deriveNativeChatSessionOptionParityHold([
        effortRow({
          state: 'unsupported',
          reason: 'effort-unsupported',
          requested: { effort: 'ultra' }
        })
      ])
    ).toBe(true)
  })

  it('does not hold the send for a matching or unobserved row', () => {
    expect(deriveNativeChatSessionOptionParityHold([effortRow()])).toBe(false)
    expect(
      deriveNativeChatSessionOptionParityHold([effortRow({ state: 'match' }), effortRow()])
    ).toBe(false)
    expect(deriveNativeChatSessionOptionParityHold([effortRow({ state: 'unobserved' })])).toBe(
      false
    )
    expect(deriveNativeChatSessionOptionParityHold([])).toBe(false)
  })
})

describe('shouldChatTakeOverMobileSurface', () => {
  it('takes over the mobile surface when the tab is in chat view', () => {
    expect(shouldChatTakeOverMobileSurface('chat')).toBe(true)
  })

  it('leaves the terminal mobile overlay in place in terminal view', () => {
    expect(shouldChatTakeOverMobileSurface('terminal')).toBe(false)
  })
})
