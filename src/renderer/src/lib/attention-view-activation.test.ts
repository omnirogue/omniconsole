import { describe, expect, it } from 'vitest'
import { shouldSwitchToTerminalViewOnActivation } from './attention-view-activation'

describe('shouldSwitchToTerminalViewOnActivation', () => {
  it('keeps the attention view for a plain workspace pick', () => {
    expect(shouldSwitchToTerminalViewOnActivation('attention', false)).toBe(false)
  })

  it('leaves the attention view when activation carries setup or startup work', () => {
    expect(shouldSwitchToTerminalViewOnActivation('attention', true)).toBe(true)
  })

  it('never re-enters the terminal view from itself', () => {
    expect(shouldSwitchToTerminalViewOnActivation('terminal', false)).toBe(false)
    expect(shouldSwitchToTerminalViewOnActivation('terminal', true)).toBe(false)
  })

  it('switches every other page to the terminal view', () => {
    expect(shouldSwitchToTerminalViewOnActivation('tasks', false)).toBe(true)
    expect(shouldSwitchToTerminalViewOnActivation('activity', true)).toBe(true)
  })
})
