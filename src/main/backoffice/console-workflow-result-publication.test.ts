import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConsoleLocalResult } from '../console-workflows/console-local-execution-contract'
import { consoleJobOutputDigest } from '../console-workflows/console-job-digests'
import { captureConsoleWorkflowPerson } from './console-workflow-person'
import {
  executionBinding,
  executionClaimRow,
  executionPrincipal
} from './console-workflow-execution-test-fixture'
import {
  consoleResultReceiptFingerprint,
  publishConsoleWorkflowResult
} from './console-workflow-result-publication'

const sentinel = 'opaque-result-bearer-sentinel'
vi.mock('./console-workflow-person', () => ({
  captureConsoleWorkflowPerson: vi.fn(),
  redactConsoleWorkflowMemory: (value: unknown) =>
    JSON.parse(JSON.stringify(value).split('opaque-result-bearer-sentinel').join('[REDACTED]'))
}))
const fetchMock = vi.fn<typeof fetch>()
function publication() {
  const result: ConsoleLocalResult = {
    status: 'done',
    exit_code: 0,
    result_exit_code: 0,
    output_tail: 'Acceptance passed.',
    candidate_sha: 'b'.repeat(40),
    branch: 'omni/job_local12345',
    pr_url: null,
    pr_number: null,
    changed_files: ['src/😀.ts'],
    owned_paths_violations: [],
    terminal_proof: {
      kind: 'exited',
      process_identity: {
        pid: 321,
        started_at: '2026-09-08T20:00:00.000Z',
        runner_instance: executionBinding.claim!.runnerInstance
      },
      process_exited: true,
      process_exit_code: 37,
      exit_cause: { kind: 'exited', exit_code: 37 },
      observed_at: '2026-09-08T20:05:00.000Z'
    },
    output_digest: ''
  }
  result.output_digest = consoleJobOutputDigest(result)
  return {
    binding: executionBinding,
    journalCursor: `sha256:${'e'.repeat(64)}`,
    idempotencyKey: 'f'.repeat(64),
    result
  }
}
function serverReplies(
  fingerprintMatches = true,
  attempt = executionBinding.attempt,
  precedingEvents = 0
) {
  fetchMock.mockImplementation(async (url) => {
    if (String(url).endsWith('/result')) {
      return new Response(
        JSON.stringify({
          ok: true,
          duplicate: false,
          job: {
            ...executionClaimRow(),
            attempt,
            status: 'done',
            protected_extra: sentinel
          }
        })
      )
    }
    const body = JSON.parse(
      fetchMock.mock.calls.find(([path]) => String(path).endsWith('/result'))![1]!.body as string
    )
    const c = executionBinding.claim!
    const after = Number(new URL(String(url)).searchParams.get('after'))
    const earlier = after < precedingEvents
    const events =
      after >= 811
        ? []
        : earlier
          ? Array.from({ length: 200 }, (_, index) => ({
              id: after + index + 1,
              job_id: executionBinding.jobId,
              kind: 'checkpoint',
              created_at: '2026-09-08T20:04:00Z',
              machine: c.host,
              detail: {}
            }))
          : [
              {
                id: 811,
                job_id: executionBinding.jobId,
                kind: 'runner_result_receipt',
                created_at: '2026-09-08T20:05:01Z',
                machine: c.host,
                detail: {
                  claim_id: c.claimedAt,
                  attempt: executionBinding.attempt,
                  host: c.host,
                  fingerprint: fingerprintMatches
                    ? consoleResultReceiptFingerprint(body, c.host)
                    : '0'.repeat(64)
                }
              }
            ]
    return new Response(
      JSON.stringify({
        ok: true,
        job_id: executionBinding.jobId,
        events,
        next_after: events.at(-1)?.id ?? after,
        status: 'done',
        cancel_requested: false
      })
    )
  })
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({
    ok: true,
    data: {
      bearer: sentinel,
      principal: executionPrincipal,
      baseUrl: 'https://console.example.test',
      isCurrent: () => true
    }
  })
})
describe('durable typed local result publication', () => {
  it('acknowledges exact durable receipt with separate acceptance zero and physical exit 37', async () => {
    serverReplies()
    const value = publication()
    expect(await publishConsoleWorkflowResult(value, executionPrincipal)).toEqual({
      ok: true,
      data: {
        eventId: '811',
        journalCursor: value.journalCursor,
        idempotencyKey: value.idempotencyKey
      }
    })
    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string)
    expect(body).toMatchObject({
      result_exit_code: 0,
      terminal_proof: { process_exit_code: 37 },
      attempt: executionBinding.attempt,
      lease_generation: executionBinding.leaseGeneration
    })
    expect(JSON.stringify(body)).not.toContain(sentinel)
  })
  it('publishes the canonical file verdict with the candidate and claim provenance', async () => {
    serverReplies()
    const value = publication()
    value.result.workflow_loop_verdict = {
      verdict: 'agree',
      blockers: [],
      gaps: [],
      notes: 'Reviewed exact candidate'
    }
    value.result.output_digest = consoleJobOutputDigest(value.result)
    expect(await publishConsoleWorkflowResult(value, executionPrincipal)).toMatchObject({
      ok: true
    })
    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string)
    expect(body).toMatchObject({
      candidate_sha: value.result.candidate_sha,
      workflow_loop_verdict: value.result.workflow_loop_verdict,
      attempt: executionBinding.attempt,
      runner_instance: executionBinding.claim!.runnerInstance
    })
  })
  it('does not publish a malformed loop verdict as an accepted result', async () => {
    const value = publication()
    value.result.workflow_loop_verdict = {
      verdict: 'pass',
      blockers: [],
      gaps: [],
      notes: 'Native review output is not canonical loop evidence.'
    } as never
    value.result.output_digest = consoleJobOutputDigest(value.result)
    expect(await publishConsoleWorkflowResult(value, executionPrincipal)).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' }
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('retains an unacknowledged result and retries the identical payload', async () => {
    serverReplies(false)
    const value = publication()
    expect(await publishConsoleWorkflowResult(value, executionPrincipal)).toMatchObject({
      ok: false,
      error: { code: 'invalid_response' }
    })
    const firstBody = fetchMock.mock.calls[0][1]!.body
    fetchMock.mockClear()
    serverReplies()
    expect(await publishConsoleWorkflowResult(value, executionPrincipal)).toMatchObject({
      ok: true
    })
    expect(fetchMock.mock.calls[0][1]!.body).toBe(firstBody)
  })
  it('acknowledges the exact historical receipt when a duplicate reply includes a newer attempt', async () => {
    serverReplies(true, executionBinding.attempt + 1)
    expect(await publishConsoleWorkflowResult(publication(), executionPrincipal)).toMatchObject({
      ok: true
    })
  })
  it('replays multiple bounded event pages to find an older retained result receipt', async () => {
    serverReplies(true, executionBinding.attempt + 1, 600)
    expect(await publishConsoleWorkflowResult(publication(), executionPrincipal)).toMatchObject({
      ok: true,
      data: { eventId: '811' }
    })
    expect(fetchMock.mock.calls.slice(1).map(([url]) => new URL(String(url)).search)).toEqual([
      '?after=0&limit=200',
      '?after=200&limit=200',
      '?after=400&limit=200',
      '?after=600&limit=200'
    ])
  })
  it('rejects acceptance output masquerading as physical proof without sending', async () => {
    const value = publication()
    value.result.terminal_proof = { kind: 'acceptance_process', exit_code: 0 }
    value.result.output_digest = consoleJobOutputDigest(value.result)
    expect(await publishConsoleWorkflowResult(value, executionPrincipal)).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' }
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('surfaces a canonical stale generation refusal verbatim', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          error: { code: 'stale_claim', message: 'operation belongs to another execution claim' }
        }),
        { status: 409 }
      )
    )
    expect(await publishConsoleWorkflowResult(publication(), executionPrincipal)).toMatchObject({
      ok: false,
      error: { code: 'stale_claim', message: 'operation belongs to another execution claim' }
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
