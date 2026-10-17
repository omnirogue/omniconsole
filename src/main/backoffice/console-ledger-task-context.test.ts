import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LedgerPaneRegistry } from '../session-ledger/ledger-identity'
import { setActiveLedgerPaneRegistry } from '../session-ledger/ledger-lookup'
import {
  readConsoleSessionTaskContext,
  readConsoleSourceSessionBinding
} from './console-session-task'

const person = vi.hoisted(() => ({ current: true, principal: 'signed-person-a' }))
vi.mock('./console-workflow-person', () => ({
  captureConsoleWorkflowPerson: async () => ({
    ok: true,
    data: {
      baseUrl: 'https://console.example.test',
      bearer: 'synthetic-credential',
      principal: person.principal,
      isCurrent: () => person.current
    }
  }),
  redactConsoleWorkflowMemory: (value: unknown) => value
}))

const pane = 'restored-tab:11111111-1111-4111-8111-111111111111'
const ledger = 'als_0123456789abcdef01234567'
const task = 'btk_original'
const pack = {
  card_id: task,
  state_revision: 7,
  available: true,
  status: 'ready',
  context: 'Original scope and acceptance criteria.\nFile: approved.pdf',
  warnings: [],
  scope: null,
  pack_version: 'pack-seven',
  replies_waiting: [],
  dropped_blocks: []
}
const canonicalRow = { ledger_id: ledger, app: 'omni-ide', card_id: task, state: 'done' }
const fetchMock = vi.fn<typeof fetch>()
let registry: LedgerPaneRegistry

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  person.current = true
  person.principal = 'signed-person-a'
  registry = new LedgerPaneRegistry({
    load: () => [
      {
        paneKey: pane,
        ledgerId: ledger,
        account: person.principal,
        cardId: task,
        cardLinkedBy: 'person',
        startedAt: '2026-09-17T00:00:00Z'
      }
    ],
    save: () => {}
  })
  setActiveLedgerPaneRegistry(registry)
  fetchMock.mockReset().mockImplementation(async (url) => {
    const path = new URL(String(url)).pathname
    if (path === `/api/sessions/${ledger}`) {
      return json({ ok: true, session: canonicalRow, events: [] })
    }
    if (path === `/api/team/tasks/${task}/agent-context`) {
      return json(pack)
    }
    if (path === `/api/board/${task}/lifecycle`) {
      return json({ task: { id: task, state_revision: 7 } })
    }
    throw new Error(`Unexpected route: ${path}`)
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  setActiveLedgerPaneRegistry(null)
  vi.unstubAllGlobals()
})

describe('canonical task context after a desktop restart', () => {
  it('recovers the exact persisted pane using read-only server confirmation on both sides', async () => {
    expect(registry.localSessions(person.principal)).toEqual([])
    expect(await readConsoleSessionTaskContext({ sourceKey: pane, taskId: task })).toEqual({
      ok: true,
      data: { ok: true, sessionId: ledger, taskId: task, context: pack }
    })
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      `/api/sessions/${ledger}`,
      `/api/team/tasks/${task}/agent-context`,
      `/api/board/${task}/lifecycle`,
      `/api/sessions/${ledger}`
    ])
    expect(fetchMock.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true)
    expect(registry.get(pane)).toMatchObject({ started: false, nativeSessionId: null })
  })

  it('refreshes a retained canonical ID and identifies its actual pane for planning', async () => {
    expect(await readConsoleSessionTaskContext({ sessionId: ledger, taskId: task })).toMatchObject({
      ok: true,
      data: { sessionId: ledger, context: pack }
    })
    expect(await readConsoleSourceSessionBinding(ledger, person.principal)).toEqual({
      ok: true,
      data: { id: ledger, board_task_id: task, session_ref: pane }
    })
  })

  it.each(['missing', 'other-person', 'ownerless', 'wrong-ledger'])(
    'refuses %s local identity before making a request',
    async (kind) => {
      if (kind === 'missing') {
        registry.remove(pane)
      }
      if (kind === 'other-person') {
        registry.update(pane, { account: 'signed-person-b' })
      }
      if (kind === 'ownerless') {
        registry.update(pane, { account: null })
      }
      const result = await readConsoleSessionTaskContext({
        sourceKey: pane,
        taskId: task,
        sessionId: kind === 'wrong-ledger' ? 'als_abcdef0123456789abcdef01' : ledger
      })
      expect(result).toMatchObject({ ok: false, error: { code: 'binding_changed' } })
      expect(fetchMock).not.toHaveBeenCalled()
    }
  )

  it.each([
    { ...canonicalRow, card_id: null },
    { ...canonicalRow, card_id: 'btk_changed' },
    { ...canonicalRow, ledger_id: 'als_abcdef0123456789abcdef01' },
    { ...canonicalRow, app: 'fleet' }
  ])('never adopts an unbound, different or foreign server row', async (row) => {
    fetchMock.mockResolvedValueOnce(json({ session: row }))
    expect(await readConsoleSessionTaskContext({ sourceKey: pane, taskId: task })).toMatchObject({
      ok: false
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each(['account', 'pane', 'attempt', 'native-session'])(
    'discards a reply when the %s changes in flight',
    async (kind) => {
      fetchMock.mockImplementationOnce(async () => {
        if (kind === 'account') {
          person.current = false
        }
        if (kind === 'pane') {
          registry.remove(pane)
        }
        if (kind === 'attempt') {
          registry.stamp(pane, { ptyId: 'replacement-pty' })
        }
        if (kind === 'native-session') {
          registry.update(pane, { nativeSessionId: 'different' })
        }
        return json({ session: canonicalRow })
      })
      expect(await readConsoleSessionTaskContext({ sourceKey: pane, taskId: task })).toMatchObject({
        ok: false
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  )

  it('rejects a task rebind during context compilation', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ session: canonicalRow }))
      .mockResolvedValueOnce(json(pack))
      .mockResolvedValueOnce(json({ task: { id: task, state_revision: 7 } }))
      .mockResolvedValueOnce(json({ session: { ...canonicalRow, card_id: 'btk_changed' } }))
    expect(await readConsoleSessionTaskContext({ sourceKey: pane, taskId: task })).toMatchObject({
      ok: false,
      error: { code: 'binding_changed' }
    })
  })

  it('does not substitute a bounded live feed or another pane when the exact row is unavailable', async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: 'Missing row' }, 404))
    expect(await readConsoleSessionTaskContext({ sourceKey: pane, taskId: task })).toMatchObject({
      ok: false
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
