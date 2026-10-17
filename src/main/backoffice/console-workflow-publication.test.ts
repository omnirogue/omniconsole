import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConsoleExecutionObservation } from '../../shared/console-workflow-types'
import { consoleJobClaimFixture } from '../runtime/orchestration/console-job-test-fixture'
import { publishConsoleExecutionObservation } from './console-workflow-publication'
import { captureConsoleWorkflowPerson } from './console-workflow-person'
import { consoleWorkflowClient } from './console-workflow-client'

vi.mock('./console-workflow-person', () => ({
  captureConsoleWorkflowPerson: vi.fn(),
  redactConsoleWorkflowMemory: (value: unknown) => value
}))
const principal = 'a'.repeat(64)
const sentinel = 'opaque-publication-token-sentinel'
const fetchMock = vi.fn<typeof fetch>()
const observation: ConsoleExecutionObservation = {
  binding: { ...consoleJobClaimFixture, jobId: 'job_journal1234' },
  journalCursor: `sha256:${'c'.repeat(64)}`,
  idempotencyKey: 'd'.repeat(64),
  event: 'checkpoint_written',
  detail: 'Acceptance check committed'
}
const submitted = {
  id: observation.idempotencyKey,
  kind: observation.event,
  cursor: observation.journalCursor,
  note: observation.detail
}
function reply(value: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(value), { status }))
}
function receipt(patch = {}) {
  return {
    job_id: observation.binding.jobId,
    events: [
      {
        id: 17,
        job_id: observation.binding.jobId,
        kind: 'local_observation',
        created_at: '2026-09-08T22:00:00Z',
        detail: { observation: submitted, attempt: 1, lease_generation: 3, ...patch }
      }
    ]
  }
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({
    ok: true,
    data: {
      bearer: sentinel,
      baseUrl: 'https://console.example.test',
      principal,
      isCurrent: () => true
    }
  })
})

describe('verified console observation receipt', () => {
  it('acknowledges only a read-back event with the exact committed content and generation', async () => {
    reply({ ok: true, event_id: 17, duplicate: true, cancel_requested: false })
    reply(receipt())
    const result = await publishConsoleExecutionObservation(observation, principal)
    expect(result).toEqual({
      ok: true,
      data: {
        eventId: '17',
        journalCursor: observation.journalCursor,
        idempotencyKey: observation.idempotencyKey
      }
    })
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://console.example.test/api/gtd/workflow-jobs/job_journal1234/progress'
    )
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toMatchObject({
      attempt: 1,
      lease_generation: 3,
      observation: submitted
    })
    expect(fetchMock.mock.calls[1][0]).toContain('/events?event_id=17')
    expect(JSON.stringify(result)).not.toContain(sentinel)
    expect(fetchMock.mock.calls[0][1]?.body).not.toContain(sentinel)
  })

  it.each([{ lease_generation: 4 }, { observation: { ...submitted, note: 'Different content' } }])(
    'retains a mismatched event receipt %j',
    async (patch) => {
      reply({ ok: true, event_id: 17, duplicate: false, cancel_requested: false })
      reply(receipt(patch))
      expect(await publishConsoleExecutionObservation(observation, principal)).toMatchObject({
        ok: false,
        error: { code: 'invalid_response' }
      })
    }
  )

  it('fences a person switch between the observation check and the HTTP request', async () => {
    const captured = await captureConsoleWorkflowPerson()
    if (!captured.ok) {
      throw new Error('fixture')
    }
    vi.mocked(captureConsoleWorkflowPerson).mockReset()
    vi.mocked(captureConsoleWorkflowPerson)
      .mockResolvedValueOnce(captured)
      .mockResolvedValue({ ok: true, data: { ...captured.data, principal: 'b'.repeat(64) } })
    expect(await publishConsoleExecutionObservation(observation, principal)).toMatchObject({
      ok: false,
      error: { code: 'principal_mismatch' }
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('preserves an explicit stale-claim refusal without a receipt read or retry', async () => {
    reply(
      {
        ok: false,
        error: { code: 'stale_claim', message: 'operation belongs to another execution claim' }
      },
      409
    )
    expect(await publishConsoleExecutionObservation(observation, principal)).toMatchObject({
      ok: false,
      error: { code: 'stale_claim', message: 'operation belongs to another execution claim' }
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('person-scoped local event replay', () => {
  it('consumes the canonical after cursor and verifies ordered events for the named job', async () => {
    reply({ ok: true, ...receipt(), next_after: 17, status: 'running', cancel_requested: false })
    const result = await consoleWorkflowClient.listJobEvents({
      jobId: observation.binding.jobId,
      after: 0
    })
    expect(result).toMatchObject({ ok: true, data: { next_after: 17, events: [{ id: 17 }] } })
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://console.example.test/api/gtd/workflow-jobs/job_journal1234/events?after=0&limit=200'
    )
  })

  it('refuses cursor regression and mutually exclusive replay filters', async () => {
    reply({ ok: true, ...receipt(), next_after: 16, status: 'running', cancel_requested: false })
    expect(
      await consoleWorkflowClient.listJobEvents({ jobId: observation.binding.jobId, after: 17 })
    ).toMatchObject({ ok: false, error: { code: 'invalid_response' } })
    fetchMock.mockClear()
    expect(
      await consoleWorkflowClient.listJobEvents({
        jobId: observation.binding.jobId,
        after: 0,
        eventId: 17
      })
    ).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
