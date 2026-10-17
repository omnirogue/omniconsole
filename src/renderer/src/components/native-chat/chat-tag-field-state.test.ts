import { describe, expect, it } from 'vitest'
import { chatTagFieldState } from './chat-tag-field-state'
import type { useChatTagComposer } from './use-chat-tag-composer'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'
import type { SessionEffortParity } from '../../../../shared/session-effort-parity'

type Tags = ReturnType<typeof useChatTagComposer>

/** Only the fields this derivation reads; the rest of the composer is not involved. */
function tags(overrides: Partial<Tags> = {}): Tags {
  return {
    active: false,
    tagging: false,
    blocked: false,
    pending: false,
    retrySaved: false,
    attaching: false,
    hasContent: true,
    ...overrides
  } as unknown as Tags
}

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

const MISMATCH: SessionEffortParity = {
  state: 'mismatch',
  reason: 'effort-differs',
  requested: { effort: 'xhigh' },
  applied: { effort: 'high' }
}

describe('chatTagFieldState send hold', () => {
  it('holds the agent send while the session runs at another effort than requested', () => {
    const state = chatTagFieldState(tags(), false, false, false, [effortRow(MISMATCH)])
    expect(state.sendButtonDisabled).toBe(true)
    // The hold is a send gate only: typing and attachments stay available.
    expect(state.disabled).toBe(false)
    expect(state.attachDisabled).toBe(false)
  })

  it('sends normally once requested and applied agree', () => {
    expect(chatTagFieldState(tags(), false, false, false, [effortRow()]).sendButtonDisabled).toBe(
      false
    )
    expect(chatTagFieldState(tags(), false, false, false).sendButtonDisabled).toBe(false)
  })

  it('never holds a chat delivery to a person or agent on an agent-session mismatch', () => {
    const state = chatTagFieldState(tags({ active: true }), false, false, false, [
      effortRow(MISMATCH)
    ])
    expect(state.sendButtonDisabled).toBe(false)
  })
})
