import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { consoleJobClaimFixture } from '../runtime/orchestration/console-job-test-fixture'
import { captureConsoleWorkflowPerson } from './console-workflow-person'
import {
  startConsoleWorkflowProcess,
  type ConsoleWorkflowProcessStart
} from './console-workflow-start'

const sentinel = 'opaque-start-bearer-sentinel'
vi.mock('./console-workflow-person', () => ({
  captureConsoleWorkflowPerson: vi.fn(),
  redactConsoleWorkflowMemory: (value: unknown) =>
    JSON.parse(JSON.stringify(value).split('opaque-start-bearer-sentinel').join('[REDACTED]'))
}))
const fetchMock = vi.fn<typeof fetch>()
const input: ConsoleWorkflowProcessStart = {
  binding: { ...consoleJobClaimFixture, jobId: 'job_start12345' },
  principal: 'a'.repeat(64),
  gate: {
    version: 1,
    state: 'closed',
    launchId: randomUUID(),
    gateId: randomUUID(),
    ptyId: 'pty-start',
    incarnationId: randomUUID(),
    pid: 911,
    processStartTimeMs: 1788910000000,
    processKind: 'pty-root',
    reportsChildExitStatus: true,
    startupCommandMode: 'exec'
  },
  projectDir: '/workspace/start',
  baseSha: 'b'.repeat(40),
  inputDigest: 'd'.repeat(64)
}

function serverJob() {
  const { binding } = input
  const claim = binding.claim!
  const canonical = {
    job_id: binding.jobId,
    task_id: binding.taskId,
    host: claim.host,
    attempt: binding.attempt,
    claimed_at: claim.claimedAt,
    runner_instance: claim.runnerInstance,
    claim_request_id: claim.claimRequestId,
    attempt_intent_id: claim.attemptIntentId,
    dispatch_key: claim.dispatchKey,
    contract_id: binding.contractId,
    contract_digest: binding.contractDigest,
    contract_generation: binding.contractGeneration
  }
  return {
    id: binding.jobId,
    task_id: binding.taskId,
    status: 'running',
    attempt: binding.attempt,
    lease_generation: binding.leaseGeneration,
    claim_host: claim.host,
    claimed_at: claim.claimedAt,
    runner_instance: claim.runnerInstance,
    claim_request_id: claim.claimRequestId,
    project_dir: input.projectDir,
    base_sha: input.baseSha,
    input_digest: input.inputDigest,
    cancel_requested: false,
    process_identity: {
      pid: input.gate.pid,
      started_at: new Date(input.gate.processStartTimeMs).toISOString(),
      runner_instance: claim.runnerInstance
    },
    execution_binding: canonical,
    execution_start_receipt: {
      binding: canonical,
      started: true,
      session_id: 'ses_server_actual',
      attempt_id: 'att_server_actual'
    },
    task_context: { protected_extra: sentinel }
  }
}
function reply(job = serverJob()) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, job })))
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({
    ok: true,
    data: {
      bearer: sentinel,
      principal: input.principal,
      baseUrl: 'https://console.example.test',
      isCurrent: () => true
    }
  })
})

describe('canonical closed-process start transport', () => {
  it('echoes the exact registered identity and returns only the real hub IDs', async () => {
    reply()
    const result = await startConsoleWorkflowProcess(input)
    expect(result).toEqual({
      ok: true,
      data: {
        ...input.binding,
        sessionId: 'ses_server_actual',
        attemptId: 'att_server_actual',
        inputDigest: input.inputDigest
      }
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://console.example.test/api/gtd/workflow-jobs/job_start12345/started')
    expect(JSON.parse(init!.body as string)).toMatchObject({
      attempt: 1,
      lease_generation: 3,
      process_identity: serverJob().process_identity,
      base_sha: input.baseSha,
      input_digest: input.inputDigest
    })
    expect(JSON.stringify(result)).not.toContain(sentinel)
    expect(init!.body).not.toContain(sentinel)
    expect(init!.body).not.toContain(input.gate.gateId)
  })

  it.each([
    { lease_generation: 4 },
    { input_digest: 'e'.repeat(64) },
    { project_dir: '/other' },
    { process_identity: { ...serverJob().process_identity, pid: 912 } },
    {
      execution_start_receipt: {
        ...serverJob().execution_start_receipt,
        binding: { ...serverJob().execution_binding, dispatch_key: 'other' }
      }
    }
  ])('refuses a start receipt for a changed process or claim: %j', async (patch) => {
    reply({ ...serverJob(), ...patch })
    expect(await startConsoleWorkflowProcess(input)).toMatchObject({
      ok: false,
      error: { code: 'invalid_response' }
    })
  })

  it('refuses a process whose wrapper cannot report provider termination before any request', async () => {
    expect(
      await startConsoleWorkflowProcess({
        ...input,
        gate: { ...input.gate, reportsChildExitStatus: false }
      })
    ).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('surfaces the canonical stale-claim refusal verbatim without retry', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          error: { code: 'stale_claim', message: 'claim changed while starting' }
        }),
        { status: 409 }
      )
    )
    expect(await startConsoleWorkflowProcess(input)).toMatchObject({
      ok: false,
      error: { code: 'stale_claim', message: 'claim changed while starting' }
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
