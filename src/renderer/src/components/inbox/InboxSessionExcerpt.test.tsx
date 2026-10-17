// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { InboxSessionExcerpt } from './InboxSessionExcerpt'
import { readRoomSessionExcerpts } from './inbox-session-excerpt'
vi.mock('./inbox-session-excerpt', () => ({ readRoomSessionExcerpts: vi.fn() }))
const read = vi.mocked(readRoomSessionExcerpts)
const session: SidebarSession = {
  rowKey: 'same-pane',
  folderKeyMigration: null,
  sessionKey: 'session-one',
  worktreeId: 'folder',
  hostId: 'local',
  tabId: 'tab',
  paneKey: 'pane',
  kind: 'terminal',
  label: 'First session',
  workspaceLabel: 'Workspace',
  agent: 'claude',
  unavailable: false,
  providerSession: { key: 'session_id', id: 'provider-one' }
}
beforeEach(() => vi.clearAllMocks())
afterEach(cleanup)
it('loads privately and requires selection before changing the public excerpt', async () => {
  const change = vi.fn()
  read.mockResolvedValue(['AI: Selected evidence'])
  render(<InboxSessionExcerpt sessions={[session]} value="" change={change} />)
  expect(read).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('Choose a session excerpt'))
  fireEvent.click(screen.getByRole('button', { name: 'Read First session' }))
  expect(await screen.findByText('AI: Selected evidence')).toBeInTheDocument()
  expect(change).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Use excerpt' }))
  expect(change).toHaveBeenCalledWith('AI: Selected evidence')
})
it('discards a pending transcript when its pane is reused by another provider session', async () => {
  let finish!: (value: string[]) => void
  read.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  const change = vi.fn()
  const { rerender } = render(<InboxSessionExcerpt sessions={[session]} value="" change={change} />)
  fireEvent.click(screen.getByText('Choose a session excerpt'))
  fireEvent.click(screen.getByRole('button', { name: 'Read First session' }))
  rerender(
    <InboxSessionExcerpt
      sessions={[
        {
          ...session,
          folderKeyMigration: null,
          sessionKey: 'session-two',
          label: 'Replacement session',
          providerSession: { key: 'session_id', id: 'provider-two' }
        }
      ]}
      value=""
      change={change}
    />
  )
  await act(async () => {
    finish(['AI: Old private transcript'])
  })
  expect(screen.queryByText('AI: Old private transcript')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Use excerpt' })).not.toBeInTheDocument()
  expect(change).not.toHaveBeenCalled()
})
