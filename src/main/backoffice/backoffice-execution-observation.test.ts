import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  captureConsoleWorkflowPerson,
  sanitizeConsoleWorkflowText
} from './console-workflow-person'
import {
  buildBackofficeExecutionNote,
  postBackofficeExecutionObservation,
  type BackofficeExecutionObservation
} from './backoffice-execution-observation'

vi.mock('./console-workflow-person', () => ({
  captureConsoleWorkflowPerson: vi.fn(),
  sanitizeConsoleWorkflowText: vi.fn()
}))
const person = {
  baseUrl: 'https://omnios.example.com',
  bearer: 'test-member-bearer',
  principal: 'person-original',
  isCurrent: vi.fn(() => true)
}

const observation: BackofficeExecutionObservation = {
  hubTaskId: 'btk_01abcdef',
  runId: 'run_123',
  journalCursor: { epoch: 'epoch_123', sequence: 4 },
  event: 'run_started'
}

function storedRow() {
  const note = buildBackofficeExecutionNote(observation)
  return { id: 'tve_123', task_id: observation.hubTaskId, note_replay_version: 1, ...note }
}

describe('backoffice execution observations', () => {
  beforeEach(() => {
    person.isCurrent.mockReturnValue(true)
    vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({ ok: true, data: person })
    vi.mocked(sanitizeConsoleWorkflowText).mockImplementation((value) => value)
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it.each(['run_started', 'checkpoint_written', 'stop_confirmed', 'worker_exit'] as const)(
    'uses the closed hub progress schema for %s without claiming completed work',
    (event) => {
      const body = buildBackofficeExecutionNote({ ...observation, event })
      expect(body.note_kind).toBe('progress')
      expect(Object.keys(body.payload).sort()).toEqual(['done', 'evidence', 'summary'])
      expect(body.payload.done).toEqual([])
      expect(body.payload.evidence).toContainEqual({
        kind: 'text',
        ref: JSON.stringify(observation.journalCursor),
        label: 'IDE journal cursor'
      })
      expect(body.payload.evidence).toContainEqual({
        kind: 'text',
        ref: observation.runId,
        label: 'IDE run id'
      })
    }
  )

  it('keeps the identity stable after reconstruction and refuses content replacement under a fresh key', () => {
    const first = buildBackofficeExecutionNote(observation)
    const restored = buildBackofficeExecutionNote(JSON.parse(JSON.stringify(observation)))
    expect(restored).toEqual(first)
    expect(first.source_event_id).toMatch(/^ide-observation-v1:[a-f0-9]{64}$/)
    expect(
      buildBackofficeExecutionNote({ ...observation, detail: 'Changed detail' }).source_event_id
    ).toBe(first.source_event_id)
    for (const changed of [
      { hubTaskId: 'btk_other123' },
      { runId: 'run_other' },
      { journalCursor: { epoch: 'epoch_123', sequence: 5 } },
      { event: 'checkpoint_written' as const },
      { workerDispatchId: 'dispatch_other' }
    ]) {
      expect(buildBackofficeExecutionNote({ ...observation, ...changed }).source_event_id).not.toBe(
        first.source_event_id
      )
    }
  })

  it('uses the same source identity after an ambiguous response without an automatic retry', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('sensitive-transport-value'))
      .mockResolvedValueOnce(Response.json(storedRow()))
    vi.stubGlobal('fetch', fetchMock)
    const failed = await postBackofficeExecutionObservation(observation)
    expect(failed.ok).toBe(false)
    expect(JSON.stringify(failed)).not.toContain('sensitive-transport-value')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await postBackofficeExecutionObservation(observation)).toEqual({
      ok: true,
      noteId: 'tve_123'
    })
    expect(fetchMock.mock.calls[0][1].body).toBe(fetchMock.mock.calls[1][1].body)
  })

  it.each([
    { principal: 'different-person', baseUrl: person.baseUrl },
    { principal: person.principal, baseUrl: 'https://other.example.com' }
  ])('refuses recovery under a different saved authority: %j', async (expected) => {
    const network = vi.fn()
    vi.stubGlobal('fetch', network)
    expect((await postBackofficeExecutionObservation(observation, expected)).ok).toBe(false)
    expect(network).not.toHaveBeenCalled()
  })

  it('refuses an account change before sending', async () => {
    person.isCurrent.mockReturnValue(false)
    const network = vi.fn()
    vi.stubGlobal('fetch', network)
    expect((await postBackofficeExecutionObservation(observation)).ok).toBe(false)
    expect(network).not.toHaveBeenCalled()
  })

  it('does not acknowledge a response after the person changes while reading it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        person.isCurrent.mockReturnValue(false)
        return Response.json(storedRow())
      })
    )
    expect((await postBackofficeExecutionObservation(observation)).ok).toBe(false)
  })

  it('refuses protected content before sending without rewriting its saved identity', async () => {
    vi.mocked(sanitizeConsoleWorkflowText).mockReturnValue('[redacted]')
    const network = vi.fn()
    vi.stubGlobal('fetch', network)
    expect((await postBackofficeExecutionObservation(observation)).ok).toBe(false)
    expect(network).not.toHaveBeenCalled()
  })

  it('bounds response bytes before accepting a receipt', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ...storedRow(), padding: 'x'.repeat(65_536) }))
    )
    expect((await postBackofficeExecutionObservation(observation)).ok).toBe(false)
  })

  it('posts only the exact comment route with the signed-in person and no redirects', async () => {
    const fetchMock = vi.fn(async () => Response.json(storedRow(), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(postBackofficeExecutionObservation(observation)).resolves.toEqual({
      ok: true,
      noteId: 'tve_123'
    })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://omnios.example.com/api/team/tasks/btk_01abcdef/comment')
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      credentials: 'omit',
      headers: { Authorization: 'Bearer test-member-bearer' }
    })
    expect(JSON.parse(init.body as string)).toEqual(buildBackofficeExecutionNote(observation))
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it.each([
    { hubTaskId: 'btk_01abcdef/../../complete' },
    { hubTaskId: 'ses_01abcdef' },
    { runId: '' },
    { journalCursor: { epoch: 'epoch_123', sequence: 0 } },
    { journalCursor: { epoch: 'epoch_123', sequence: 1.5 } },
    { journalCursor: '' },
    { event: 'complete_task' }
  ])('refuses malformed observations before auth or network: %j', async (fields) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const result = await postBackofficeExecutionObservation({
      ...observation,
      ...fields
    } as BackofficeExecutionObservation)
    expect(result.ok).toBe(false)
    expect(captureConsoleWorkflowPerson).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps unsigned local execution local', async () => {
    vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({
      ok: false,
      error: { code: 'signed_out', message: 'Sign in' }
    })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect((await postBackofficeExecutionObservation(observation)).ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([401, 403, 404, 409, 503])(
    'returns a refusal on HTTP %s without retrying',
    async (status) => {
      const fetchMock = vi.fn(async () => new Response('', { status }))
      vi.stubGlobal('fetch', fetchMock)
      expect(await postBackofficeExecutionObservation(observation)).toEqual({
        ok: false,
        message: `Execution progress was refused (HTTP ${status}).`
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  )

  it.each([
    { id: 'evt_123', note: 'legacy plain comment' },
    { ...storedRow(), task_id: 'btk_ffffffff' },
    { ...storedRow(), note_kind: null },
    { ...storedRow(), note_replay_version: undefined },
    { ...storedRow(), note_replay_version: true },
    { ...storedRow(), source_event_id: 'another-event' },
    { ...storedRow(), note: 'Different content' },
    { ...storedRow(), id: 'evt_legacy' },
    { ...storedRow(), payload: { ...storedRow().payload, summary: 'Different summary' } },
    { ...storedRow(), payload: { ...storedRow().payload, done: ['Completed task'] } },
    { ...storedRow(), payload: { evidence: [] } }
  ])(
    'does not claim a typed projection was stored for an incompatible acknowledgment',
    async (body) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json(body))
      )
      expect((await postBackofficeExecutionObservation(observation)).ok).toBe(false)
    }
  )

  it('returns transport failure as data and does not retry a potentially stored note', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('connection lost after sending')
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(postBackofficeExecutionObservation(observation)).resolves.toEqual({
      ok: false,
      message: 'The shared save was not confirmed. Your local session is unchanged.'
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
