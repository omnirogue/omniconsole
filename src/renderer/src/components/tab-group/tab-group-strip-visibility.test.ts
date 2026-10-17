import { describe, expect, it } from 'vitest'
import { shouldHideTabGroupStrip } from './tab-group-strip-visibility'

describe('shouldHideTabGroupStrip', () => {
  it.each(['chat', 'terminal'] as const)(
    'keeps a lone conversation strip hidden in %s',
    (viewMode) => {
      const conversation = {
        activeTabViewMode: viewMode,
        tabCount: 1,
        activeTabContentType: 'terminal',
        hasAgent: true
      }
      expect(shouldHideTabGroupStrip(conversation)).toBe(true)
    }
  )

  it('keeps the strip when the group has more than one tab, even in chat mode', () => {
    expect(
      shouldHideTabGroupStrip({
        tabCount: 2,
        activeTabContentType: 'terminal',
        hasAgent: true
      })
    ).toBe(false)
  })

  it('keeps the strip for a single plain terminal tab', () => {
    expect(
      shouldHideTabGroupStrip({
        tabCount: 1,
        activeTabContentType: 'terminal',
        hasAgent: false
      })
    ).toBe(false)
  })

  it('keeps the strip when the tab has no known agent', () => {
    expect(
      shouldHideTabGroupStrip({
        tabCount: 1,
        activeTabContentType: 'terminal',
        hasAgent: false
      })
    ).toBe(false)
  })

  it('keeps the strip for a single non-terminal tab (editor/browser/etc.)', () => {
    expect(
      shouldHideTabGroupStrip({
        tabCount: 1,
        activeTabContentType: 'editor',
        hasAgent: false
      })
    ).toBe(false)
  })

  it('keeps the strip when Chat UI is off, since chat can never render there', () => {
    expect(
      shouldHideTabGroupStrip({
        tabCount: 1,
        activeTabContentType: 'terminal',
        hasAgent: true,
        nativeChatUiEnabled: false
      })
    ).toBe(false)
  })

  it('keeps the strip when this group owns client-hosted browser rows', () => {
    expect(
      shouldHideTabGroupStrip({
        tabCount: 1,
        activeTabContentType: 'terminal',
        hasAgent: true,
        hasClientHostedRows: true
      })
    ).toBe(false)
  })
})
