// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { focusTerminalTabSurface } from './focus-terminal-tab-surface'
import { installTerminalAccessibleIdentity } from '../components/terminal-pane/terminal-accessible-identity'

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})
function pane(tabId: string, leafId: string): HTMLTextAreaElement {
  const tab = document.createElement('div')
  tab.dataset.terminalTabId = tabId
  const leaf = document.createElement('div')
  leaf.dataset.leafId = leafId
  const input = document.createElement('textarea')
  input.className = 'xterm-helper-textarea'
  input.setAttribute('aria-label', 'Terminal input')
  leaf.append(input)
  tab.append(leaf)
  document.body.append(tab)
  return input
}
function flushFocus(): () => void {
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  return () => {
    while (frames.length) {
      frames.shift()!(0)
    }
  }
}
describe('terminal DOM focus ownership', () => {
  it('moves native DOM focus from another tab to the exact requested pane', () => {
    const flush = flushFocus()
    const other = pane('tab-a', 'leaf-a')
    const sibling = pane('tab-b', 'leaf-b1')
    const intended = pane('tab-b', 'leaf-b2')
    other.focus()
    focusTerminalTabSurface('tab-b', 'leaf-b2')
    flush()
    expect(document.activeElement).toBe(intended)
    expect(other.matches(':focus')).toBe(false)
    expect(sibling.matches(':focus')).toBe(false)
  })
  it('does not focus another tab if the requested surface is missing', () => {
    const flush = flushFocus()
    const other = pane('tab-a', 'leaf-a')
    focusTerminalTabSurface('missing')
    flush()
    expect(document.activeElement).not.toBe(other)
  })
  it.each(['text', 'line\n', 'a\r\nb', ''])(
    'forwards %j through xterm typed input without adding Enter',
    (value) => {
      const input = pane('tab-a', 'leaf-a')
      const sendInput = vi.fn()
      const identity = installTerminalAccessibleIdentity(
        { textarea: input, focus: () => input.focus(), input: sendInput },
        'tab-a:leaf-a'
      )
      const event = new CustomEvent('omni-terminal-accessible-action', {
        detail: { paneKey: 'tab-a:leaf-a', value },
        cancelable: true
      })
      input.dispatchEvent(event)
      expect(document.activeElement).toBe(input)
      expect(event.defaultPrevented).toBe(true)
      if (value) {
        expect(sendInput).toHaveBeenCalledWith(value, true)
      } else {
        expect(sendInput).not.toHaveBeenCalled()
      }
      identity.dispose()
    }
  )
  it('keeps the localized xterm label and a distinct stable pane identity', async () => {
    const input = pane('tab-a', 'leaf-a')
    const identity = installTerminalAccessibleIdentity(
      { textarea: input, focus: () => input.focus(), input: vi.fn() },
      'tab-a:leaf-a'
    )
    expect(input.getAttribute('aria-label')).toBe('Terminal input (omni-terminal=tab-a%3Aleaf-a)')
    input.setAttribute('aria-label', 'Eingabe')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(input.getAttribute('aria-label')).toBe('Eingabe (omni-terminal=tab-a%3Aleaf-a)')
    identity.dispose()
  })
})
