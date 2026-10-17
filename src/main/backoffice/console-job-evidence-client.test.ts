import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  readConsoleFleetJobEventPage,
  readConsoleJobEvidence,
  readConsoleJobLog
} from './console-job-evidence-client'

const state = vi.hoisted(() => ({ current: true }))
vi.mock('./console-workflow-person', () => ({
  captureConsoleWorkflowPerson: async () => ({
    ok: true,
    data: {
      bearer: 'evidence-fixture-token',
      baseUrl: 'https://console.example.test',
      principal: 'person',
      isCurrent: () => state.current
    }
  }),
  redactConsoleWorkflowMemory: (value: unknown) => value
}))

const jobId = 'job_evidence01'
const page = {
  job_id: jobId,
  attempt: 2,
  lease_generation: 4,
  host: 'mw0002',
  provider: 'codex',
  session_id: 'thread_1',
  entries: [{ id: 7, kind: 'input', text: 'Review it', at: '2026-09-12T12:00:00Z' }],
  next_after: 7,
  has_more: false,
  complete: false
}
const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => {
  state.current = true
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(Response.json(page))
})

describe('job evidence read boundary', () => {
  it('pins the job attempt and lease while paging through its existing authenticated transport', async () => {
    expect(
      await readConsoleJobEvidence({ jobId, attempt: 2, leaseGeneration: 4, after: 3, limit: 100 })
    ).toEqual({ ok: true, data: page })
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://console.example.test/api/gtd/jobs/job_evidence01/evidence?attempt=2&lease_generation=4&after=3&limit=100'
    )
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      credentials: 'omit',
      redirect: 'error',
      headers: { Authorization: 'Bearer evidence-fixture-token' }
    })
  })

  it.each([
    { job_id: 'job_other000' },
    { attempt: 3 },
    { lease_generation: 5 },
    { next_after: 6 },
    { entries: [{ ...page.entries[0], id: 3 }] },
    { entries: [], next_after: 3, has_more: true }
  ])('rejects wrong identity and cursors: %j', async (patch) => {
    fetchMock.mockResolvedValue(Response.json({ ...page, ...patch }))
    expect(
      await readConsoleJobEvidence({ jobId, attempt: 2, leaseGeneration: 4, after: 3 })
    ).toMatchObject({ ok: false, error: { code: 'invalid_response' } })
  })

  it('does not fetch malformed IDs or excessive pages', async () => {
    expect(await readConsoleJobEvidence({ jobId: '../private', limit: 201 })).toMatchObject({
      ok: false
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps unauthorized and unavailable reads as refusals', async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        { error: { code: 'job_forbidden', message: 'Not assigned to this task.' } },
        { status: 403 }
      )
    )
    expect(await readConsoleJobEvidence({ jobId })).toMatchObject({
      ok: false,
      error: { code: 'job_forbidden', status: 403 }
    })
  })

  it('normalizes the BFF event timestamp and preserves its pagination cursor', async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        job_id: jobId,
        events: [
          {
            id: 8,
            job_id: jobId,
            at: '2026-09-12T12:00:00Z',
            kind: 'claimed',
            detail: {},
            machine: 'mw0002'
          }
        ],
        next_after: 8,
        has_more: true
      })
    )
    const result = await readConsoleFleetJobEventPage(jobId, 7)
    expect(result).toMatchObject({
      ok: true,
      data: { next_after: 8, has_more: true, events: [{ created_at: '2026-09-12T12:00:00Z' }] }
    })
  })

  it('reads saved output only for the requested attempt', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ job_id: jobId, attempt: 2, host: 'mw0002', log: 'saved output', at: 'now' })
    )
    expect(await readConsoleJobLog({ jobId, attempt: 2 })).toMatchObject({ ok: true })
    expect(await readConsoleJobLog({ jobId, attempt: 1 })).toMatchObject({ ok: false })
  })

  it('discards evidence if the signed-in connection changes during the read', async () => {
    fetchMock.mockImplementation(async () => {
      state.current = false
      return Response.json(page)
    })
    expect(await readConsoleJobEvidence({ jobId })).toMatchObject({
      ok: false,
      error: { code: 'connection_changed' }
    })
  })
})
