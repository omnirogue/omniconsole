// @vitest-environment happy-dom
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  actOnTerminalAccessibleRenderer,
  registerTerminalAccessibleWindow
} from './terminal-accessible-renderer'

let unregisterWindow: (() => void) | undefined
afterEach(() => {
  unregisterWindow?.()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})
function harness(options: { focuses?: boolean; documentFocused?: boolean } = {}) {
  const input = document.createElement('textarea')
  document.body.append(input)
  const sendInput = vi.fn()
  input.dataset.omniTerminalPane = 'tab:leaf'
  const accept = (event: Event): void => {
    const detail = (event as CustomEvent).detail
    event.preventDefault()
    if (options.focuses === false) {
      detail.result = { focused: false, applied: false }
      return
    }
    input.focus()
    sendInput(detail.value, true)
    detail.result = { focused: true, applied: true }
  }
  input.addEventListener('omni-terminal-accessible-action', accept)
  const binding = {
    dispose: () => input.removeEventListener('omni-terminal-accessible-action', accept)
  }
  vi.spyOn(document, 'hasFocus').mockReturnValue(options.documentFocused !== false)
  unregisterWindow = registerTerminalAccessibleWindow({
    isFocused: () => true,
    isDestroyed: () => false,
    webContents: {
      executeJavaScript: (script: string) =>
        runInNewContext(script, {
          document,
          CustomEvent,
          requestAnimationFrame: (callback: () => void) => callback()
        })
    }
  })
  return { input, sendInput, binding }
}
describe('accessible renderer delivery', () => {
  it('focuses the exact bound input and forwards text literally through xterm', async () => {
    const { input, sendInput, binding } = harness()
    const text = 'literal ` ${text} " \\ and newline\n'
    await actOnTerminalAccessibleRenderer('tab:leaf', text)
    expect(document.activeElement).toBe(input)
    expect(sendInput).toHaveBeenCalledExactlyOnceWith(text, true)
    binding.dispose()
  })
  it('refuses a missing pane without writing to the focused sibling', async () => {
    const { input, sendInput, binding } = harness()
    input.focus()
    await expect(actOnTerminalAccessibleRenderer('missing', 'x')).rejects.toMatchObject({
      code: 'element_not_found'
    })
    expect(sendInput).not.toHaveBeenCalled()
    binding.dispose()
  })
  it('reports a pane that matched but refused keyboard focus', async () => {
    const { sendInput, binding } = harness({ focuses: false })
    await expect(actOnTerminalAccessibleRenderer('tab:leaf', 'x')).rejects.toMatchObject({
      code: 'window_not_focused'
    })
    expect(sendInput).not.toHaveBeenCalled()
    binding.dispose()
  })
  it('tells a pane that is there from a keyboard that is elsewhere', async () => {
    // A guest view (browser tab, editor) can hold the keyboard while the window itself is
    // focused. Observing again cannot change that, so it must not read as a stale element.
    const { sendInput, binding } = harness({ documentFocused: false })
    await expect(actOnTerminalAccessibleRenderer('tab:leaf', 'x')).rejects.toMatchObject({
      code: 'window_not_focused'
    })
    expect(sendInput).not.toHaveBeenCalled()
    binding.dispose()
  })
  it('refuses when the OS has no focused app window', async () => {
    unregisterWindow?.()
    await expect(actOnTerminalAccessibleRenderer('tab:leaf', 'x')).rejects.toMatchObject({
      code: 'window_not_focused'
    })
  })
})
