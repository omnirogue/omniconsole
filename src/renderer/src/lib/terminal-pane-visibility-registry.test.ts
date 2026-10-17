import { describe, expect, it } from 'vitest'
import {
  isTerminalTabRendererVisible,
  registerTerminalPaneVisibility
} from './terminal-pane-visibility-registry'

describe('a terminal tab’s live visibility, as its panes report it', () => {
  it('reads the pane’s own ref live, and a tab with no mounted pane as hidden', () => {
    const ref = { current: false }
    expect(isTerminalTabRendererVisible('tab-1')).toBe(false)
    const off = registerTerminalPaneVisibility('tab-1', ref)
    expect(isTerminalTabRendererVisible('tab-1')).toBe(false)
    ref.current = true
    expect(isTerminalTabRendererVisible('tab-1')).toBe(true)
    off()
    expect(isTerminalTabRendererVisible('tab-1')).toBe(false)
  })

  it('is visible while any of its mounted panes is, and unregisters each on its own', () => {
    const hidden = { current: false }
    const shown = { current: true }
    const offHidden = registerTerminalPaneVisibility('tab-2', hidden)
    const offShown = registerTerminalPaneVisibility('tab-2', shown)
    expect(isTerminalTabRendererVisible('tab-2')).toBe(true)
    offShown()
    expect(isTerminalTabRendererVisible('tab-2')).toBe(false)
    offHidden()
    offHidden()
    expect(isTerminalTabRendererVisible('tab-2')).toBe(false)
  })
})
