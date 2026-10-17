// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { sidebarSessionSourceIdentity } from '@/lib/sidebar-session-source-identity'
import { useSessionTasks } from '@/store/session-task-store'
import { TaskSessionsSection } from './TaskSessionsSection'

const mocks = vi.hoisted(() => ({ sessions: [] as SidebarSession[], activate: vi.fn() }))
vi.mock('@/components/sidebar/session-folders/use-sidebar-sessions', () => ({
  useSidebarSessions: () => mocks.sessions
}))
vi.mock('@/lib/activate-sidebar-session', () => ({
  activateSidebarSession: mocks.activate
}))
afterEach(() => {
  cleanup()
  useSessionTasks.setState({ links: {}, loaded: false })
  vi.unstubAllGlobals()
})

it('keeps fifty distinct sessions with the same title and opens the linked structured session', async () => {
  const local: SidebarSession = {
    rowKey: 'structured-source',
    sessionKey: 'structured-source',
    worktreeId: 'folder:test',
    hostId: 'local',
    tabId: 'structured-agent-session-agent001',
    paneKey: null,
    kind: 'structured',
    label: 'Shared outcome work',
    workspaceLabel: 'Product',
    agent: 'codex',
    unavailable: false,
    folderKeyMigration: null
  }
  const sourceKey = sidebarSessionSourceIdentity(local)!.sourceKey
  mocks.sessions = [local]
  useSessionTasks.setState({
    loaded: true,
    links: { [sourceKey]: { taskId: 'btk_parent001', sessionId: 'ses_child000' } }
  })
  const taskSessions = vi.fn().mockResolvedValue({
    ok: true,
    data: {
      sessions: Array.from({ length: 50 }, (_, index) => ({
        id: `ses_child${String(index).padStart(3, '0')}`,
        title: 'Shared outcome work',
        state: 'running',
        machineId: 'fleet'
      }))
    }
  })
  vi.stubGlobal('api', { consoleWorkflows: { taskSessions } })
  const { container } = render(<TaskSessionsSection taskId="btk_parent001" />)
  await waitFor(() => expect(container.querySelectorAll('li')).toHaveLength(50))
  expect(container.querySelectorAll('[data-task-session]')).toHaveLength(49)
  expect(container.querySelectorAll('[data-task-session-local]')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'Shared outcome work here' }))
  expect(mocks.activate).toHaveBeenCalledWith(local)
  expect(taskSessions).toHaveBeenCalledWith({ taskId: 'btk_parent001' })
})
