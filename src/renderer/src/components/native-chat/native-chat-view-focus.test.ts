// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { focusNativeChatView } from './native-chat-view-focus'
const mocks = vi.hoisted(() => ({ mode: 'terminal', refreshIme: vi.fn() }))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      unifiedTabsByWorktree: { workspace: [{ id: 'unified', viewMode: mocks.mode }] }
    })
  }
}))
vi.mock('../terminal-pane/terminal-ime-input-context-refresh', () => ({
  refreshTerminalImeInputContext: mocks.refreshIme
}))
let frames: FrameRequestCallback[]
function flushFrames() {
  while (frames.length) {
    const pending = frames.splice(0)
    pending.forEach((frame) => frame(0))
  }
}
beforeEach(() => {
  mocks.mode = 'terminal'
  mocks.refreshIme.mockClear()
  frames = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  document.body.innerHTML =
    '<div data-terminal-tab-id="terminal"><div data-leaf-id="leaf"><textarea class="xterm-helper-textarea"></textarea></div><div class="native-chat-pane-shell"><input aria-label="Search" /><div data-native-chat-composer><textarea></textarea></div></div></div>'
})
afterEach(() => {
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})
it('preserves a rename input mounted while terminal focus is queued', () => {
  focusNativeChatView('workspace', 'unified', 'terminal', 'leaf', 'terminal')
  const rename = document.createElement('input')
  rename.setAttribute('data-tab-rename-input', 'true')
  document.body.append(rename)
  rename.focus()
  flushFrames()
  expect(document.activeElement).toBe(rename)
  expect(mocks.refreshIme).not.toHaveBeenCalled()
})
it('focuses the exact terminal leaf with IME refresh', () => {
  focusNativeChatView('workspace', 'unified', 'terminal', 'leaf', 'terminal')
  flushFrames()
  expect(document.activeElement).toBe(document.querySelector('.xterm-helper-textarea'))
  expect(mocks.refreshIme).toHaveBeenCalledWith(document.activeElement, expect.any(Object))
})
it('focuses the composer instead of an earlier search input', () => {
  mocks.mode = 'chat'
  focusNativeChatView('workspace', 'unified', 'terminal', 'leaf', 'chat')
  flushFrames()
  expect(document.activeElement).toBe(
    document.querySelector('[data-native-chat-composer] textarea')
  )
})
