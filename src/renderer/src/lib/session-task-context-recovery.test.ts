// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { linkSessionToTask, useSessionTasks } from '@/store/session-task-store'
import { buildPaneSessions, buildSidebarSessions } from './sidebar-sessions'
import { sidebarSessionSourceIdentity } from './sidebar-session-source-identity'
import { prepareSessionTaskContext, hasRefreshableTaskContext } from './session-task-context'
import { recoverSessionTaskContext } from './session-task-context-recovery'
import {
  sessionTestSource,
  addSessionTestTab,
  addSessionTestRecord
} from './sidebar-session-test-fixtures'
import { parseSessionTaskLinks, SESSION_TASK_STORAGE_KEY } from './session-task-link'
import type { ConsoleSessionAttachResult } from '../../../shared/console-workflow-types'

const api = vi.hoisted(() => ({ read: vi.fn() }))
let previousApi: Window['api']
vi.mock('./console-workflow-client', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  consoleWorkflowApi: () => ({ sessionTaskContext: api.read })
}))

const ledger = 'als_0123456789abcdef01234567'
const attachment: ConsoleSessionAttachResult = {
  ok: true,
  sessionId: ledger,
  taskId: 'btk_original',
  context: {
    card_id: 'btk_original',
    state_revision: 4,
    available: true,
    status: 'ready',
    context: 'Approved parent scope and original acceptance criteria.',
    pack_version: 'pack-four',
    scope: null,
    warnings: [],
    replies_waiting: [],
    dropped_blocks: []
  }
}

function fixture() {
  const state = sessionTestSource()
  const tab = addSessionTestTab(state)
  const record = addSessionTestRecord(state, tab)
  useAppStore.setState({ ...state, activeOrcaProfileId: 'person-a' })
  const session = buildSidebarSessions(useAppStore.getState())[0]!
  const key = sidebarSessionSourceIdentity(session)!.sourceKey
  linkSessionToTask(key, { taskId: 'btk_original', title: 'Original outcome' })
  return { state, tab, record, session, key }
}

beforeEach(() => {
  previousApi = window.api
  localStorage.clear()
  useSessionTasks.setState({ links: {}, loaded: true })
  api.read.mockReset().mockResolvedValue({ ok: true, data: attachment })
})
afterEach(() => {
  window.api = previousApi
})

function resumedFixture() {
  const result = fixture()
  linkSessionToTask(result.key, null)
  const readLink = vi.fn().mockResolvedValue({
    ledgerId: ledger,
    cardId: attachment.taskId,
    cardTitle: 'Original outcome'
  })
  window.api = { ...window.api, sessionLedger: { taskLink: readLink } } as unknown as Window['api']
  return { ...result, readLink }
}

describe('resumed pane task discovery', () => {
  it('recovers the resumed pane task when its original provider tab is still present', async () => {
    const { state, record, session: original, readLink } = resumedFixture()
    const tab = addSessionTestTab(state, 'resumed-tab')
    const resumed = addSessionTestRecord(state, tab, record.providerSession.id)
    useAppStore.setState(state)
    expect(buildSidebarSessions(useAppStore.getState()).map((row) => row.paneKey)).toEqual([
      original.paneKey
    ])
    const session = buildPaneSessions(useAppStore.getState()).find(
      (row) => row.paneKey === resumed.paneKey
    )!
    expect(await recoverSessionTaskContext(session)).toBe(true)
    expect(readLink).toHaveBeenCalledExactlyOnceWith(resumed.paneKey)
    expect(useSessionTasks.getState().links[resumed.paneKey]?.taskId).toBe(attachment.taskId)
    expect(useSessionTasks.getState().links[original.paneKey!]).toBeUndefined()
    expect(prepareSessionTaskContext('Continue', resumed.paneKey).text).toContain(
      attachment.context!.context
    )
  })

  it('confirms the new pane’s canonical binding before caching the task or injecting its context', async () => {
    const { session, key, readLink } = resumedFixture()
    const first = recoverSessionTaskContext(session)
    const second = recoverSessionTaskContext({ ...session })
    expect(second).toBe(first)
    expect(await first).toBe(true)
    expect(readLink).toHaveBeenCalledExactlyOnceWith(key)
    expect(api.read).toHaveBeenCalledExactlyOnceWith({
      sourceKey: key,
      taskId: attachment.taskId,
      sessionId: ledger
    })
    expect(useSessionTasks.getState().links[key]).toEqual({
      taskId: attachment.taskId,
      title: 'Original outcome',
      sessionId: ledger
    })
    expect(prepareSessionTaskContext('Continue', key).text).toContain(attachment.context!.context)
  })

  it('keeps a refused server binding out of the presentation cache', async () => {
    const { session, key } = resumedFixture()
    api.read.mockResolvedValue({ ok: false, error: { code: 'unavailable', message: 'Offline' } })
    expect(await recoverSessionTaskContext(session)).toBe(false)
    expect(useSessionTasks.getState().links[key]).toBeUndefined()
    expect(prepareSessionTaskContext('Continue', key).text).toBe('Continue')
  })

  it.each(['account-roundtrip', 'native-session', 'rebind'])(
    'rejects delayed discovery after %s',
    async (changed) => {
      const { session, key, record, readLink } = resumedFixture()
      let resolve!: (link: { ledgerId: string; cardId: string }) => void
      readLink.mockReturnValue(
        new Promise((done) => {
          resolve = done
        })
      )
      const pending = recoverSessionTaskContext(session)
      if (changed === 'account-roundtrip') {
        useAppStore.setState({ activeOrcaProfileId: 'person-b' })
        useAppStore.setState({ activeOrcaProfileId: 'person-a' })
      } else if (changed === 'native-session') {
        useAppStore.setState({
          sleepingAgentSessionsByPaneKey: {
            [key]: { ...record, providerSession: { key: 'session_id', id: 'replacement' } }
          }
        })
      } else {
        linkSessionToTask(key, { taskId: 'btk_newtask' })
      }
      resolve({ ledgerId: ledger, cardId: 'btk_original' })
      expect(await pending).toBe(false)
      expect(api.read).not.toHaveBeenCalled()
      expect(useSessionTasks.getState().links[key]?.taskId).not.toBe(attachment.taskId)
    }
  )
})

describe('restored conversation task context', () => {
  it('confirms an old pane link before persisting the canonical ID and injecting context', async () => {
    const { session, key } = fixture()
    expect(hasRefreshableTaskContext(session)).toBe(false)
    expect(prepareSessionTaskContext('Continue', key).text).toBe('Continue')
    expect(await recoverSessionTaskContext(session)).toBe(true)
    expect(api.read).toHaveBeenCalledExactlyOnceWith({ sourceKey: key, taskId: 'btk_original' })
    expect(hasRefreshableTaskContext(session)).toBe(true)
    expect(prepareSessionTaskContext('Continue', key).text).toContain(attachment.context!.context)
    expect(
      parseSessionTaskLinks(JSON.parse(localStorage.getItem(SESSION_TASK_STORAGE_KEY)!))[key]
    ).toEqual({
      taskId: 'btk_original',
      title: 'Original outcome',
      sessionId: ledger
    })
  })

  it('coalesces Chat and Terminal requests for the same source without injecting twice', async () => {
    const { session, key } = fixture()
    const first = recoverSessionTaskContext(session)
    const second = recoverSessionTaskContext({ ...session })
    expect(first).toBe(second)
    expect(await first).toBe(true)
    expect(api.read).toHaveBeenCalledTimes(1)
    prepareSessionTaskContext('First turn', key).commit()
    expect(await recoverSessionTaskContext(session)).toBe(true)
    expect(prepareSessionTaskContext('Second turn', key).text).toBe('Second turn')
    expect(api.read).toHaveBeenCalledTimes(1)
  })

  it.each(['offline', 'wrong-task', 'no-context', 'changed-id'])(
    'leaves the warning and original cache intact after %s',
    async (kind) => {
      const { session, key } = fixture()
      if (kind === 'changed-id') {
        linkSessionToTask(key, {
          taskId: 'btk_original',
          sessionId: 'als_abcdef0123456789abcdef01'
        })
      }
      const before = useSessionTasks.getState().links[key]
      api.read.mockResolvedValue(
        kind === 'offline'
          ? { ok: false, error: { code: 'unavailable', message: 'Offline' } }
          : {
              ok: true,
              data: {
                ...attachment,
                ...(kind === 'wrong-task' ? { taskId: 'btk_other' } : {}),
                ...(kind === 'no-context' ? { context: undefined } : {})
              }
            }
      )
      expect(await recoverSessionTaskContext(session)).toBe(false)
      expect(useSessionTasks.getState().links[key]).toBe(before)
      expect(hasRefreshableTaskContext(session)).toBe(false)
      expect(prepareSessionTaskContext('Continue', key).text).toBe('Continue')
    }
  )

  it.each(['account-roundtrip', 'native-session', 'host', 'unlink', 'rebind'])(
    'discards a late reply after %s',
    async (kind) => {
      const { session, key, state, record } = fixture()
      let resolve!: (value: { ok: true; data: ConsoleSessionAttachResult }) => void
      api.read.mockReturnValue(
        new Promise((done) => {
          resolve = done
        })
      )
      const pending = recoverSessionTaskContext(session)
      expect(api.read).toHaveBeenCalledOnce()
      if (kind === 'account-roundtrip') {
        useAppStore.setState({ activeOrcaProfileId: 'person-b' })
        useAppStore.setState({ activeOrcaProfileId: 'person-a' })
      }
      if (kind === 'native-session') {
        useAppStore.setState({
          sleepingAgentSessionsByPaneKey: {
            [key]: { ...record, providerSession: { key: 'session_id', id: 'replacement' } }
          }
        })
      }
      if (kind === 'host') {
        useAppStore.setState({
          worktreesByRepo: {
            'repo-a': state.worktreesByRepo['repo-a']!.map((row) => ({
              ...row,
              hostId: 'runtime:other'
            }))
          }
        })
      }
      if (kind === 'unlink') {
        linkSessionToTask(key, null)
      }
      if (kind === 'rebind') {
        linkSessionToTask(key, { taskId: 'btk_replacement' })
      }
      resolve({ ok: true, data: attachment })
      expect(await pending).toBe(false)
      expect(hasRefreshableTaskContext(session)).toBe(false)
      expect(prepareSessionTaskContext('Continue', key).text).toBe('Continue')
    }
  )

  it('does not spread recovered memory to another terminal pane', async () => {
    const { session, key } = fixture()
    const state = sessionTestSource()
    const secondTab = addSessionTestTab(state, 'second-tab')
    addSessionTestRecord(state, secondTab, 'second-native')
    useAppStore.setState((current) => ({
      tabsByWorktree: {
        [secondTab.worktreeId]: [...current.tabsByWorktree[secondTab.worktreeId]!, secondTab]
      },
      terminalLayoutsByTabId: {
        ...current.terminalLayoutsByTabId,
        ...state.terminalLayoutsByTabId
      },
      sleepingAgentSessionsByPaneKey: {
        ...current.sleepingAgentSessionsByPaneKey,
        ...state.sleepingAgentSessionsByPaneKey
      }
    }))
    const other = buildSidebarSessions(useAppStore.getState()).find(
      (row) => row.tabId === secondTab.id
    )!
    const otherKey = sidebarSessionSourceIdentity(other)!.sourceKey
    linkSessionToTask(otherKey, { taskId: 'btk_other' })
    expect(await recoverSessionTaskContext(session)).toBe(true)
    expect(prepareSessionTaskContext('Continue', key).text).toContain(attachment.context!.context)
    expect(prepareSessionTaskContext('Continue', otherKey).text).toBe('Continue')
    expect(hasRefreshableTaskContext(other)).toBe(false)
  })

  it('supports existing hub session bindings without inventing a canonical ID', async () => {
    const { session, key } = fixture()
    linkSessionToTask(key, { taskId: 'btk_original', sessionId: 'ses_original' })
    api.read.mockResolvedValue({ ok: true, data: { ...attachment, sessionId: 'ses_original' } })
    expect(await recoverSessionTaskContext(session)).toBe(true)
    expect(api.read).toHaveBeenCalledExactlyOnceWith({
      taskId: 'btk_original',
      sessionId: 'ses_original'
    })
  })
})
