// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionProjectThread } from '@/lib/session-project-threads'
import { emptyProjectSettings } from '../../../../shared/project-settings'

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  starting: false,
  openSession: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({ openProjectsPage: () => undefined })
}))
vi.mock('@/components/sidebar/session-folders/NewConversationButton', () => ({
  NewConversationButton: () => null
}))
vi.mock('@/lib/open-sidebar-session', () => ({ openSidebarSession: mocks.openSession }))
vi.mock('./use-project-coordinator-launch', () => ({
  useProjectCoordinatorLaunch: () => ({ start: mocks.start, starting: mocks.starting })
}))
vi.mock('./SessionProjectJiraIssues', () => ({ SessionProjectJiraIssues: () => null }))
import { SessionProjectHeader } from './SessionProjectHeader'

const folder = { id: '00000000-0000-4000-8000-000000000001', name: 'Website' }
const chat = {
  row: { session: { rowKey: 'chat', label: 'Project chat' } },
  status: null,
  isCoordinator: true,
  agent: 'codex',
  lastActivityAt: null
} as unknown as SessionProjectThread

afterEach(() => {
  cleanup()
  mocks.start.mockClear()
  mocks.openSession.mockClear()
})

it('offers to start the chat until its session is listed, then opens it', () => {
  const settings = emptyProjectSettings(1)
  const { rerender } = render(
    <SessionProjectHeader folder={folder} settings={settings} company={null} coordinator={null} />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Start coordinator' }))
  expect(mocks.start).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('button', { name: 'Project chat' })).toBeNull()

  rerender(
    <SessionProjectHeader folder={folder} settings={settings} company={null} coordinator={chat} />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Project chat' }))
  expect(mocks.openSession).toHaveBeenCalledWith(chat.row.session)
  expect(screen.queryByRole('button', { name: 'Start coordinator' })).toBeNull()
})

it('has no chat for a folder that is not a project', () => {
  render(<SessionProjectHeader folder={folder} settings={null} company={null} coordinator={null} />)
  expect(screen.queryByRole('button', { name: 'Start coordinator' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Project chat' })).toBeNull()
})
