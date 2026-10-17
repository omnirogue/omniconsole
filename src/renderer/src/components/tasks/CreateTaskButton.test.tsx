// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { linkSessionToTask, useSessionTasks } from '@/store/session-task-store'
import { buildSidebarSessions, type SidebarSession } from '@/lib/sidebar-sessions'
import { selectConsoleAccountScope } from '@/lib/console-account-scope'
import { sidebarSessionSourceIdentity } from '@/lib/sidebar-session-source-identity'
import { rememberAttachedTaskContext } from '@/lib/session-task-context'
import {
  sessionTestSource,
  addSessionTestTab,
  addSessionTestRecord
} from '@/lib/sidebar-session-test-fixtures'
import { CreateTaskButton } from './CreateTaskButton'

vi.mock('./CreateTaskDialog', () => ({ CreateTaskDialog: () => null }))
vi.mock('./SessionTaskSheet', () => ({
  SessionTaskSheet: ({ taskId }: { taskId: string }) => (
    <div data-testid="opened-task">{taskId}</div>
  )
}))

vi.mock('./AttachToTaskDialog', () => ({
  AttachToTaskDialog: ({ session }: { session: SidebarSession | null }) =>
    session ? <div data-testid="reattach-session">{session.paneKey}</div> : null
}))

const openTaskPage = vi.fn()
const readContext = vi.fn()
let previousApi: Window['api']
beforeEach(() => {
  cleanup()
  localStorage.clear()
  vi.clearAllMocks()
  readContext.mockResolvedValue({
    ok: false,
    error: { code: 'unavailable', message: 'Unavailable' }
  })
  previousApi = window.api
  window.api = { consoleWorkflows: { sessionTaskContext: readContext } } as unknown as Window['api']
  useSessionTasks.setState({ links: {}, loaded: true })
})
afterEach(() => {
  cleanup()
  window.api = previousApi
})

function fixture(confirmed: boolean, canonical = false) {
  const source = sessionTestSource()
  const tab = addSessionTestTab(source)
  addSessionTestRecord(source, tab)
  useAppStore.setState({ ...source, activeOrcaProfileId: 'person-a', setActiveView: openTaskPage })
  const session = buildSidebarSessions(useAppStore.getState())[0]!
  linkSessionToTask(sidebarSessionSourceIdentity(session)!.sourceKey, {
    taskId: 'btk_parent001',
    ...(canonical ? {} : { sessionId: 'ses_source001' }),
    title: 'Launch'
  })
  if (confirmed) {
    rememberAttachedTaskContext(
      session,
      {
        ok: true,
        taskId: 'btk_parent001',
        sessionId: 'ses_source001',
        context: {
          card_id: 'btk_parent001',
          available: true,
          state_revision: 4,
          status: 'ready',
          context: 'Current shared outcome',
          pack_version: 'v4',
          scope: null,
          warnings: [],
          replies_waiting: [],
          dropped_blocks: []
        }
      },
      selectConsoleAccountScope(useAppStore.getState())
    )
  }
  render(
    <TooltipProvider>
      <CreateTaskButton session={session} />
    </TooltipProvider>
  )
  return session
}

it('warns for an old link and opens the existing attachment flow for this exact conversation', () => {
  const session = fixture(false)
  fireEvent.click(screen.getByRole('button', { name: 'Reattach for task updates' }))
  expect(screen.getByRole('status').textContent).toBe(
    'Reattach this conversation once to receive task context updates.'
  )
  expect(screen.getByRole('button', { name: 'Open task' })).toBeTruthy()
  fireEvent.click(screen.getAllByRole('button', { name: 'Reattach for task updates' }).at(-1)!)
  expect(screen.getByTestId('reattach-session').textContent).toBe(session.paneKey)
  expect(openTaskPage).not.toHaveBeenCalled()
})

it('keeps Open task available while reattachment is needed', () => {
  fixture(false)
  fireEvent.click(screen.getByRole('button', { name: 'Reattach for task updates' }))
  fireEvent.click(screen.getByRole('button', { name: 'Open task' }))
  expect(screen.getByTestId('opened-task').textContent).toBe('btk_parent001')
  expect(openTaskPage).not.toHaveBeenCalled()
  expect(screen.queryByTestId('reattach-session')).toBeNull()
})

it('opens a confirmed task directly and changes the badge after an account switch', () => {
  fixture(true)
  fireEvent.click(screen.getByRole('button', { name: 'Open task' }))
  expect(screen.getByTestId('opened-task').textContent).toBe('btk_parent001')
  expect(openTaskPage).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Reattach for task updates' })).toBeNull()
  act(() => useAppStore.setState({ activeOrcaProfileId: 'person-b' }))
  expect(screen.queryByTestId('opened-task')).toBeNull()
  expect(screen.getByRole('button', { name: 'Reattach for task updates' })).toBeTruthy()
})

it('restores Open task after confirming the old pane link without requiring manual reattachment', async () => {
  readContext.mockResolvedValue({
    ok: true,
    data: {
      ok: true,
      sessionId: 'als_0123456789abcdef01234567',
      taskId: 'btk_parent001',
      context: {
        card_id: 'btk_parent001',
        available: true,
        state_revision: 4,
        status: 'ready',
        context: 'Original shared outcome',
        pack_version: 'pack-four',
        scope: null,
        warnings: [],
        replies_waiting: [],
        dropped_blocks: []
      }
    }
  })
  const session = fixture(false, true)
  fireEvent.click(await screen.findByRole('button', { name: 'Open task' }))
  expect(screen.getByTestId('opened-task').textContent).toBe('btk_parent001')
  expect(screen.queryByRole('button', { name: 'Reattach for task updates' })).toBeNull()
  expect(readContext).toHaveBeenCalledExactlyOnceWith({
    sourceKey: session.paneKey,
    taskId: 'btk_parent001'
  })
})
