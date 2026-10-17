import { beforeEach, describe, expect, it, vi } from 'vitest'
import { currentBearerToken } from './backoffice-auth'
import { getBackofficeSnapshot } from './backoffice-config'
import { ensureActiveOrcaProfile } from '../omni-profiles/profile-index-store'
import { getProfileUserDataPath } from '../omni-profiles/profile-storage-paths'
import { isCloudSessionMutationCurrent } from '../omni-profiles/profile-cloud-session-mutation'
import {
  attachConsoleSession,
  ingestConsoleSession,
  readConsoleTaskCard,
  readConsoleSessionTaskContext,
  readConsoleTaskSessions
} from './console-session-task'

vi.mock('./backoffice-auth', () => ({ currentBearerToken: vi.fn() }))
vi.mock('./backoffice-config', () => ({ getBackofficeSnapshot: vi.fn() }))
vi.mock('../omni-profiles/profile-index-store', () => ({ ensureActiveOrcaProfile: vi.fn() }))
vi.mock('../omni-profiles/profile-storage-paths', () => ({ getProfileUserDataPath: vi.fn() }))
vi.mock('../omni-profiles/profile-cloud-session-mutation', () => ({
  cloudSessionIdentity: (id: string, cloud: { userId: string }) => ({
    localProfileId: id,
    cloudUserId: cloud.userId
  }),
  captureCloudSessionMutation: vi.fn(() => ({ epoch: 1, identityKey: 'audit' })),
  isCloudSessionMutationCurrent: vi.fn()
}))

const baseUrl = 'https://console.example.test'
const fetchMock = vi.fn<typeof fetch>()

function reply(body: unknown, status = 200): void {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  )
}

function lastCall(): { url: string; body: unknown } {
  const call = fetchMock.mock.calls.at(-1)!
  const init = call[1] as { body?: string } | undefined
  return { url: String(call[0]), body: init?.body ? JSON.parse(init.body) : undefined }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  vi.mocked(currentBearerToken).mockResolvedValue('opaque-person-credential-sentinel')
  vi.mocked(getBackofficeSnapshot).mockReturnValue({ configured: true, env: 'production', baseUrl })
  vi.mocked(getProfileUserDataPath).mockReturnValue('/virtual/profile')
  vi.mocked(ensureActiveOrcaProfile).mockReturnValue({
    profile: { id: 'profile-a', cloud: { userId: 'person-a' } }
  } as never)
  vi.mocked(isCloudSessionMutationCurrent).mockReturnValue(true)
})

describe('a conversation, a task, and the link between them', () => {
  it('reports the conversation to the hub and keeps the canonical session id', async () => {
    reply({ session: { id: 'ses_abcd1234' } })
    const result = await ingestConsoleSession({
      sessionRef: 'tab-1:leaf-2',
      cwd: '/Users/maintainer/Work/OmniRogue/Sales',
      provider: 'claude',
      title: 'Simplify handoffs',
      model: 'opus'
    })
    expect(result).toMatchObject({ ok: true, data: { sessionId: 'ses_abcd1234' } })
    const { url, body } = lastCall()
    expect(url).toBe(`${baseUrl}/api/gtd/hub/api/sessions/ingest`)
    expect(body).toMatchObject({
      session_id: 'tab-1:leaf-2',
      session_ref: 'tab-1:leaf-2',
      provider: 'claude',
      state: 'running',
      title: 'Simplify handoffs'
    })
  })

  it('accepts the flat ingest answer some hub versions return', async () => {
    reply({ id: 'ses_00001111' })
    const result = await ingestConsoleSession({
      sessionRef: 'tab-1:leaf-2',
      cwd: '/tmp/x',
      provider: 'claude'
    })
    expect(result).toMatchObject({ ok: true, data: { sessionId: 'ses_00001111' } })
  })

  it("accepts the live hub's {ok, session_id} answer", async () => {
    reply({ ok: true, session_id: 'ses_abcd1234', state: 'running' })
    expect(
      await ingestConsoleSession({ sessionRef: 'tab-1:leaf-2', cwd: '/tmp/x', provider: 'claude' })
    ).toMatchObject({ ok: true, data: { sessionId: 'ses_abcd1234' } })
  })

  it('says plainly that there is no hub session when the hub echoes this desktop’s own ref', async () => {
    // Why: hub person ingest keeps no ledger copy, so it answers with the ref it was given.
    // Attaching to that id would 404; the conversation's task link lives on the session ledger.
    reply({ ok: true, session_id: 'tab-1:leaf-2' })
    const result = await ingestConsoleSession({
      sessionRef: 'tab-1:leaf-2',
      cwd: '/tmp/x',
      provider: 'claude'
    })
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'hub_session_unavailable',
        message: 'This conversation has no hub session; its task link lives on the session ledger.'
      }
    })
  })

  it('attaches a session to one task and refuses ids of the wrong shape before any request', async () => {
    reply({ session_id: 'ses_abcd1234', board_task_id: 'btk_1234abcd' })
    reply({ available: false }, 503)
    expect(
      await attachConsoleSession({ sessionId: 'ses_abcd1234', taskId: 'btk_1234abcd' })
    ).toMatchObject({ ok: true })
    expect(fetchMock.mock.calls[0]![0]).toBe(
      `${baseUrl}/api/gtd/hub/api/sessions/ses_abcd1234/attach`
    )
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({
      board_task_id: 'btk_1234abcd'
    })
    fetchMock.mockClear()
    expect(
      await attachConsoleSession({ sessionId: 'ses_abcd1234', taskId: 'dcn_1234abcd' })
    ).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns the byte-preserved shared memory with exact parent and current revision', async () => {
    const context = {
      card_id: 'btk_1234abcd',
      state_revision: 7,
      available: true,
      status: 'degraded',
      context: 'Original task scope.\nHuman decision: preserve the acceptance criteria.\n',
      warnings: ['Knowledge index temporarily unavailable.'],
      scope: { repos: [], tags: ['development'] },
      pack_version: 'pack-17',
      replies_waiting: [],
      dropped_blocks: ['older observations']
    }
    reply({ session_id: 'ses_abcd1234', board_task_id: 'btk_1234abcd' })
    reply(context)
    reply({ task: { id: 'btk_1234abcd', state_revision: 7 } })
    expect(
      await attachConsoleSession({ sessionId: 'ses_abcd1234', taskId: 'btk_1234abcd' })
    ).toEqual({
      ok: true,
      data: { ok: true, sessionId: 'ses_abcd1234', taskId: 'btk_1234abcd', context }
    })
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      `${baseUrl}/api/gtd/hub/api/sessions/ses_abcd1234/attach`,
      `${baseUrl}/api/team/tasks/btk_1234abcd/agent-context`,
      `${baseUrl}/api/board/btk_1234abcd/lifecycle`
    ])
    expect(
      fetchMock.mock.calls.every(
        ([, init]) =>
          (init?.headers as Record<string, string> | undefined)?.Authorization ===
          'Bearer opaque-person-credential-sentinel'
      )
    ).toBe(true)
  })

  it.each([
    { session_id: 'ses_other000', board_task_id: 'btk_1234abcd' },
    { session_id: 'ses_abcd1234', board_task_id: 'btk_other000' },
    { ok: true }
  ])('does not infer a context binding from a wrong or empty acknowledgement', async (answer) => {
    reply(answer)
    expect(
      await attachConsoleSession({ sessionId: 'ses_abcd1234', taskId: 'btk_1234abcd' })
    ).toMatchObject({ ok: false, error: { code: 'invalid_response' } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each(['stale', 'wrong-task', 'unavailable', 'oversized'])(
    'keeps the attached task but refuses %s memory',
    async (kind) => {
      reply({ session_id: 'ses_abcd1234', board_task_id: 'btk_1234abcd' })
      reply({
        card_id: kind === 'wrong-task' ? 'btk_other000' : 'btk_1234abcd',
        state_revision: 7,
        available: kind !== 'unavailable',
        status: kind === 'unavailable' ? 'unavailable' : 'ready',
        context: kind === 'oversized' ? 'x'.repeat(48_001) : 'Original scope',
        warnings: [],
        scope: null,
        pack_version: 1,
        replies_waiting: [],
        dropped_blocks: []
      })
      if (kind === 'stale') {
        reply({ task: { id: 'btk_1234abcd', state_revision: 8 } })
      }
      const result = await attachConsoleSession({
        sessionId: 'ses_abcd1234',
        taskId: 'btk_1234abcd'
      })
      expect(result).toMatchObject({
        ok: true,
        data: { taskId: 'btk_1234abcd', contextWarning: expect.any(String) }
      })
      expect(result.ok && result.data.context).toBeUndefined()
    }
  )

  it('refuses context delivery when the account changes after attachment', async () => {
    reply({ session_id: 'ses_abcd1234', board_task_id: 'btk_1234abcd' })
    fetchMock.mockImplementationOnce(async () => {
      vi.mocked(isCloudSessionMutationCurrent).mockReturnValue(false)
      return new Response(JSON.stringify({ available: false }), { status: 503 })
    })
    expect(
      await attachConsoleSession({ sessionId: 'ses_abcd1234', taskId: 'btk_1234abcd' })
    ).toMatchObject({ ok: false, error: { code: 'connection_changed' } })
  })

  it.each([
    [{ text: 'Waiting for the release checks', by: 'emp_sal', at: null }, true],
    [{ text: '', by: null, at: null }, false],
    ['Waiting for the release checks', true],
    ['  ', false],
    [null, false],
    [true, true]
  ])('reads the Console blocked projection %j as %s', async (blocked, expected) => {
    reply({ ok: true, card: { id: 'btk_1234abcd', title: 'Proposal', blocked } })
    expect(await readConsoleTaskCard({ taskId: 'btk_1234abcd' })).toMatchObject({
      ok: true,
      data: { id: 'btk_1234abcd', blocked: expected }
    })
  })

  it('reads one task whole and every session that has worked it', async () => {
    reply({
      ok: true,
      card: {
        id: 'btk_1234abcd',
        title: 'Simplify handoffs',
        status: 'open',
        owner_employee_id: 'emp_sal',
        company_slug: 'omnirogue',
        next_action: 'Uma reviews',
        blocked: false
      }
    })
    const card = await readConsoleTaskCard({ taskId: 'btk_1234abcd' })
    expect(card).toMatchObject({
      ok: true,
      data: { title: 'Simplify handoffs', nextAction: 'Uma reviews', blocked: false }
    })
    expect(lastCall().url).toBe(`${baseUrl}/api/work/card/btk_1234abcd`)
    reply({
      ok: true,
      sessions: [
        { id: 'ses_abcd1234', title: 'Implementation', state: 'running', model: 'opus' },
        { id: 'ses_efgh5678', title: null, state: 'completed', machine_id: 'mw0002' }
      ]
    })
    const sessions = await readConsoleTaskSessions({ taskId: 'btk_1234abcd' })
    expect(sessions.ok && sessions.data.sessions.map((row) => row.id)).toEqual([
      'ses_abcd1234',
      'ses_efgh5678'
    ])
    expect(sessions.ok && sessions.data.sessions[1]!.title).toBeNull()
    expect(lastCall().url).toBe(`${baseUrl}/api/work/card/btk_1234abcd/sessions`)
  })
})

const freshPack = {
  card_id: 'btk_1234abcd',
  state_revision: 7,
  available: true,
  status: 'ready',
  context: 'New task file: uploads/latest.pdf sha256=abcd',
  warnings: [],
  scope: null,
  pack_version: 'changed-without-revision',
  replies_waiting: [],
  dropped_blocks: []
}
const boundSession = { id: 'ses_abcd1234', board_task_id: 'btk_1234abcd' }
const refreshRequest = { sessionId: boundSession.id, taskId: boundSession.board_task_id }

describe('read-only confirmed task context refresh', () => {
  it('stops before the pack read when the captured person changes', async () => {
    fetchMock.mockImplementationOnce(async () => {
      vi.mocked(isCloudSessionMutationCurrent).mockReturnValue(false)
      return new Response(JSON.stringify(boundSession), { status: 200 })
    })
    expect(await readConsoleSessionTaskContext(refreshRequest)).toMatchObject({
      ok: false,
      error: { code: 'connection_changed' }
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reads current sources and verifies the exact session binding on both sides', async () => {
    reply(boundSession)
    reply(freshPack)
    reply({ task: { id: freshPack.card_id, state_revision: freshPack.state_revision } })
    reply(boundSession)
    expect(await readConsoleSessionTaskContext(refreshRequest)).toMatchObject({
      ok: true,
      data: { ...refreshRequest, context: freshPack }
    })
    expect(fetchMock.mock.calls.map((call) => (call[1] as RequestInit).method)).toEqual([
      'GET',
      'GET',
      'GET',
      'GET'
    ])
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      `${baseUrl}/api/gtd/hub/api/sessions/${boundSession.id}`
    )
    expect(String(fetchMock.mock.calls.at(-1)![0])).toBe(
      `${baseUrl}/api/gtd/hub/api/sessions/${boundSession.id}`
    )
  })

  it.each([null, 'btk_other123'])(
    'never reads a task pack after unbind or rebind (%s)',
    async (task) => {
      reply({ ...boundSession, board_task_id: task })
      expect(await readConsoleSessionTaskContext(refreshRequest)).toMatchObject({
        ok: false,
        error: { code: 'binding_changed' }
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  )

  it('discards context if the session is rebound while its source read is pending', async () => {
    reply(boundSession)
    reply(freshPack)
    reply({ task: { id: freshPack.card_id, state_revision: 7 } })
    reply({ ...boundSession, board_task_id: 'btk_changed123' })
    const result = await readConsoleSessionTaskContext(refreshRequest)
    expect(result).toMatchObject({ ok: false, error: { code: 'binding_changed' } })
    expect(result.ok).toBe(false)
  })

  it('fails honestly when the context is unavailable and performs no attach mutation', async () => {
    reply(boundSession)
    reply({ available: false }, 503)
    expect(await readConsoleSessionTaskContext(refreshRequest)).toMatchObject({
      ok: false,
      error: { code: 'context_unavailable' }
    })
    expect(fetchMock.mock.calls.every((call) => (call[1] as RequestInit).method === 'GET')).toBe(
      true
    )
  })
})
