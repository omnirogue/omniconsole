import { beforeEach, describe, expect, it, vi } from 'vitest'
import { activateConsoleWorkflowJob, readConsoleWorkflowHandoff } from './console-workflow-handoff'
import { captureConsoleWorkflowPerson } from './console-workflow-person'
import {
  executionBinding,
  executionHandoff,
  executionPrincipal
} from './console-workflow-execution-test-fixture'

const sentinel = 'opaque-local-handoff-sentinel'
vi.mock('./console-workflow-person', () => ({
  captureConsoleWorkflowPerson: vi.fn(),
  redactConsoleWorkflowMemory: (value: unknown) =>
    JSON.parse(JSON.stringify(value).split('opaque-local-handoff-sentinel').join('[REDACTED]'))
}))
const fetchMock = vi.fn<typeof fetch>()
const reply = (value: unknown) =>
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(value)))
const handoff = () => ({
  ok: true,
  handoff: executionHandoff(),
  workflow_inputs: [],
  blockers: [],
  ready: true
})
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

describe('one named executable handoff and explicit activation', () => {
  it('reads without activation and names exactly one job when explicitly activated', async () => {
    reply(handoff())
    const ready = await readConsoleWorkflowHandoff(executionBinding.jobId, executionPrincipal)
    expect(ready).toMatchObject({
      ok: true,
      data: { placement: 'local', state: 'ready', prompt: executionHandoff().agent_brief }
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1]?.method).toBe('GET')
    if (!ready.ok) {
      throw new Error('Expected a ready handoff')
    }
    const c = executionBinding.claim!
    reply({
      ...handoff(),
      handoff: { ...executionHandoff(), status: 'running' },
      claim: {
        job_id: executionBinding.jobId,
        host: c.host,
        attempt: executionBinding.attempt,
        lease_generation: executionBinding.leaseGeneration,
        claimed_at: c.claimedAt,
        runner_instance: c.runnerInstance,
        claim_request_id: c.claimRequestId,
        attempt_intent_id: c.attemptIntentId,
        dispatch_key: c.dispatchKey
      }
    })
    const answer = await activateConsoleWorkflowJob({
      job: ready.data,
      principal: executionPrincipal,
      runnerInstance: c.runnerInstance,
      claimRequestId: c.claimRequestId
    })
    expect(answer).toMatchObject({
      ok: true,
      data: {
        binding: {
          jobId: executionBinding.jobId,
          claim: c,
          leaseGeneration: executionBinding.leaseGeneration
        }
      }
    })
    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe(
      `https://console.example.test/api/gtd/workflow-jobs/${executionBinding.jobId}/activate`
    )
    expect(JSON.parse(init!.body as string)).toEqual({
      runner_instance: c.runnerInstance,
      claim_request_id: c.claimRequestId
    })
    expect(JSON.stringify(answer)).not.toContain(sentinel)
  })

  it.each([
    { acceptance_commands: undefined },
    { checkouts: [{ repo: 'another/repo' }] },
    { agent_brief: sentinel },
    { acceptance_commands: [{ program: 'node', args: ['line\nbreak'], timeout_ms: 1000 }] }
  ])('rejects an unsupported or protected frozen handoff before activation: %j', async (patch) => {
    reply({ ...handoff(), handoff: { ...executionHandoff(), ...patch } })
    expect(
      await readConsoleWorkflowHandoff(executionBinding.jobId, executionPrincipal)
    ).toMatchObject({ ok: false, error: { code: 'invalid_response' } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('preserves an explicitly empty server acceptance contract', async () => {
    reply({ ...handoff(), handoff: { ...executionHandoff(), acceptance_commands: [] } })
    expect(
      await readConsoleWorkflowHandoff(executionBinding.jobId, executionPrincipal)
    ).toMatchObject({ ok: true, data: { acceptanceCommands: [] } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns fleet placement for observation and refuses local activation', async () => {
    reply({ ...handoff(), handoff: { ...executionHandoff(), placement: 'fleet' } })
    const ready = await readConsoleWorkflowHandoff(executionBinding.jobId, executionPrincipal)
    if (!ready.ok) {
      throw new Error('Expected the fleet handoff')
    }
    expect(
      await activateConsoleWorkflowJob({
        job: ready.data,
        principal: executionPrincipal,
        runnerInstance: 'request_runner',
        claimRequestId: 'request_claim'
      })
    ).toMatchObject({ ok: false })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(
      fetchMock.mock.calls.some(([url]) => /runner|beat|next|seat|slots/.test(String(url)))
    ).toBe(false)
  })
})

it('preserves the sealed Git artifact contract and refuses ambiguous command-plus-artifact acceptance', async () => {
  const artifact_result = { path: 'work-result.json', format: 'json', max_bytes: 65536 }
  reply({
    ...handoff(),
    handoff: { ...executionHandoff(), artifact_result, acceptance_commands: [] }
  })
  expect(
    await readConsoleWorkflowHandoff(executionBinding.jobId, executionPrincipal)
  ).toMatchObject({
    ok: true,
    data: {
      repo: executionHandoff().repo,
      acceptanceCommands: [],
      artifactResult: { path: 'work-result.json', format: 'json', maxBytes: 65536 }
    }
  })
  reply({ ...handoff(), handoff: { ...executionHandoff(), artifact_result } })
  expect(
    await readConsoleWorkflowHandoff(executionBinding.jobId, executionPrincipal)
  ).toMatchObject({
    ok: false,
    error: { code: 'invalid_response' }
  })
})
