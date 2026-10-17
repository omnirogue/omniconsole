// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { useSessionTasks } from '@/store/session-task-store'
import { buildSidebarSessions } from '@/lib/sidebar-sessions'
import { prepareSessionTaskContext } from '@/lib/session-task-context'
import {
  sessionTestSource,
  addSessionTestTab,
  addSessionTestRecord
} from '@/lib/sidebar-session-test-fixtures'
import { createTaskFromSession } from './create-task-submit'

vi.mock('@/components/task-page/backoffice/backoffice-work-store', () => ({
  invalidateBackofficeWork: () => {}
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const api = {
  createTask: vi.fn(),
  ingestSession: vi.fn(),
  attachSession: vi.fn(),
  linkCard: vi.fn(),
  sessionTaskContext: vi.fn()
}
const ledger = 'als_0123456789abcdef01234567'
const task = 'btk_original'
let previousApi: Window['api']

beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  useSessionTasks.setState({ links: {}, loaded: true })
  const state = sessionTestSource()
  addSessionTestRecord(state, addSessionTestTab(state))
  useAppStore.setState({ ...state, activeOrcaProfileId: 'person-a' })
  api.createTask.mockResolvedValue({ ok: true, taskId: task, title: 'Original outcome' })
  api.ingestSession.mockResolvedValue({
    ok: false,
    error: { code: 'hub_session_unavailable', message: 'No duplicate hub session' }
  })
  api.linkCard.mockResolvedValue(true)
  api.sessionTaskContext.mockResolvedValue({
    ok: true,
    data: {
      ok: true,
      sessionId: ledger,
      taskId: task,
      context: {
        card_id: task,
        available: true,
        state_revision: 1,
        status: 'ready',
        context: 'Keep the approved acceptance criteria.',
        pack_version: 'pack-one',
        scope: null,
        warnings: [],
        replies_waiting: [],
        dropped_blocks: []
      }
    }
  })
  previousApi = window.api
  window.api = {
    backoffice: { createTask: api.createTask },
    consoleWorkflows: {
      ingestSession: api.ingestSession,
      attachSession: api.attachSession,
      sessionTaskContext: api.sessionTaskContext
    },
    sessionLedger: { linkCard: api.linkCard }
  } as unknown as Window['api']
})

afterEach(() => {
  window.api = previousApi
})

it('attaches the one saved task through its canonical ledger and prepares its confirmed context', async () => {
  const session = buildSidebarSessions(useAppStore.getState())[0]!
  expect(await createTaskFromSession(session, { title: 'Original outcome' })).toMatchObject({
    ok: true,
    taskId: task,
    sessionId: ledger,
    attached: true,
    ledgerLinked: true
  })
  expect(api.createTask).toHaveBeenCalledOnce()
  expect(api.attachSession).not.toHaveBeenCalled()
  expect(api.linkCard).toHaveBeenCalledExactlyOnceWith(session.paneKey, {
    cardId: task,
    cardTitle: 'Original outcome'
  })
  expect(api.sessionTaskContext).toHaveBeenCalledExactlyOnceWith({
    sourceKey: session.paneKey,
    taskId: task
  })
  expect(useSessionTasks.getState().links[session.paneKey!]!.sessionId).toBe(ledger)
  expect(prepareSessionTaskContext('Continue', session.paneKey!).text).toContain(
    'Keep the approved acceptance criteria.'
  )
})

it('keeps one saved task and reports unavailable context when server confirmation fails', async () => {
  api.sessionTaskContext.mockResolvedValue({
    ok: false,
    error: { code: 'binding_changed', message: 'Unconfirmed link' }
  })
  const session = buildSidebarSessions(useAppStore.getState())[0]!
  expect(await createTaskFromSession(session, { title: 'Original outcome' })).toMatchObject({
    ok: true,
    taskId: task,
    attached: false,
    ledgerLinked: true,
    contextWarning: expect.any(String)
  })
  expect(api.createTask).toHaveBeenCalledOnce()
  expect(prepareSessionTaskContext('Continue', session.paneKey!).text).toBe('Continue')
})
