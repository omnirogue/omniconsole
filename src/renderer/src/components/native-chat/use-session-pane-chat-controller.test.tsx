// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  getSessionPaneChatController,
  sessionPaneChatKey
} from '@/lib/session-pane-chat-controller'
import type { useStructuredAgentSession } from './use-structured-agent-session'
vi.mock('@/store', () => ({
  useAppStore: (select: (state: unknown) => unknown) =>
    select({
      settings: { commandCenter: true },
      unifiedTabsByWorktree: { wt: [{ id: 'tab', executionHostId: 'local' }] }
    })
}))
vi.mock('@/lib/sidebar-session-context', () => ({
  sidebarSessionWorkspace: () => ({ hostId: 'local' })
}))
import { useSessionPaneChatController } from './use-session-pane-chat-controller'
afterEach(cleanup)
it('publishes the existing controller and fences stale send callbacks after hide, pause and unmount', () => {
  const send = vi.fn(() => true)
  const controller = {
    writable: true,
    prompts: [],
    messages: [],
    outbox: [],
    supportsLiveInput: false,
    send,
    isWorking: false
  } as unknown as ReturnType<typeof useStructuredAgentSession>
  function Harness({ visible, tabId = 'tab' }: { visible: boolean; tabId?: string }): null {
    useSessionPaneChatController(
      { worktreeId: 'wt', tabId, viewer: true, isVisible: visible },
      { ...controller }
    )
    return null
  }
  const view = render(<Harness visible />)
  const key = sessionPaneChatKey('local', 'wt', 'tab')
  const published = getSessionPaneChatController(key)!
  expect(published.writable).toBe(true)
  expect(published.send('Continue')).toBe(true)
  expect(send).toHaveBeenCalledWith('Continue', [])
  controller.outbox = [{ state: 'queued' }] as typeof controller.outbox
  view.rerender(<Harness visible />)
  expect(getSessionPaneChatController(key)?.writable).toBe(false)
  expect(published.send('Pending launch')).toBe(false)
  controller.outbox = []
  view.rerender(<Harness visible={false} />)
  expect(getSessionPaneChatController(key)?.writable).toBe(false)
  expect(published.send('Hidden')).toBe(false)
  controller.writable = false
  view.rerender(<Harness visible />)
  expect(getSessionPaneChatController(key)?.writable).toBe(false)
  expect(published.send('Paused')).toBe(false)
  controller.writable = true
  view.rerender(<Harness visible tabId="other" />)
  expect(getSessionPaneChatController(key)).toBeNull()
  expect(published.send('Previous session')).toBe(false)
  view.unmount()
  expect(getSessionPaneChatController(sessionPaneChatKey('local', 'wt', 'other'))).toBeNull()
})
