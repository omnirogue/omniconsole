// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionProjectThread } from '@/lib/session-project-threads'
import { viewHostsTerminalPortals } from '../activity/activity-terminal-portal'

const mocks = vi.hoisted(() => ({
  portals: vi.fn(),
  openSession: vi.fn()
}))
vi.mock('../session-grid/use-session-grid-portals', () => ({
  useSessionGridTerminalPortals: mocks.portals
}))
vi.mock('@/lib/open-sidebar-session', () => ({ openSidebarSession: mocks.openSession }))
vi.mock('../attention/AttentionTerminalSlot', () => ({
  AttentionTerminalSlot: ({
    header,
    setTarget
  }: {
    header: React.ReactNode
    setTarget: (target: HTMLElement | null) => void
  }) => (
    <section>
      {header}
      <div ref={setTarget} data-target="" />
    </section>
  )
}))
import { SessionProjectChatPane } from './SessionProjectChatPane'

const thread = {
  row: { session: { rowKey: 'chat', tabId: 'tab', worktreeId: 'wt', kind: 'terminal' } },
  status: null,
  isCoordinator: true,
  agent: 'codex',
  lastActivityAt: null
} as unknown as SessionProjectThread

afterEach(() => {
  cleanup()
  mocks.portals.mockClear()
  mocks.openSession.mockClear()
})

it('borrows the chat into its slot once the slot is on the page, and opens the tab on request', () => {
  render(<SessionProjectChatPane thread={thread} activeWorktreeId="other" />)
  const last = mocks.portals.mock.calls.at(-1)!
  expect(last[0]).toEqual([
    {
      paneId: 'project-chat',
      session: thread.row.session,
      target: document.querySelector('[data-target]')
    }
  ])
  expect(last[1]).toBe('project-chat')
  expect(last[2]).toBe('other')
  expect(screen.getByText('Codex')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Open in tab' }))
  expect(mocks.openSession).toHaveBeenCalledWith(thread.row.session)
})

it('is a view Terminal lends panes to', () => {
  expect(viewHostsTerminalPortals('project')).toBe(true)
})
