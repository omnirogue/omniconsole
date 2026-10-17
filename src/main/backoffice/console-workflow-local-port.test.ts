import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createConsoleWorkflowLocalPort } from './console-workflow-local-port'
import { captureConsoleWorkflowPerson } from './console-workflow-person'
import {
  executionBinding,
  executionClaimRow,
  executionHandoff,
  executionPrincipal
} from './console-workflow-execution-test-fixture'

const state = vi.hoisted(() => ({ directory: '', observed: true }))
const sentinel = 'opaque-port-bearer-sentinel'
vi.mock('../omni-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => state.directory
}))
vi.mock('../ipc/pty/provider/registry', () => ({
  getNativeLocalPtyProvider: () => ({ supportsLaunchGateObservation: () => state.observed })
}))
vi.mock('./console-workflow-person', () => ({
  captureConsoleWorkflowPerson: vi.fn(),
  getConsolePublicationPrincipal: async () => 'a'.repeat(64),
  sanitizeConsoleWorkflowText: (value: string) =>
    value.replaceAll('opaque-port-bearer-sentinel', '[REDACTED]'),
  redactConsoleWorkflowMemory: (value: unknown) =>
    JSON.parse(JSON.stringify(value).replaceAll('opaque-port-bearer-sentinel', '[REDACTED]'))
}))
const fetchMock = vi.fn<typeof fetch>()
const request = () => ({
  jobId: executionBinding.jobId,
  workflowId: executionBinding.workflowId,
  approvedDigest: executionHandoff().workflow.digest,
  worktree: 'id:local-repo'
})
const reply = (value: unknown) => new Response(JSON.stringify(value))
beforeEach(() => {
  vi.resetAllMocks()
  state.directory = mkdtempSync(join(tmpdir(), 'console-port-'))
  state.observed = true
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
afterEach(() => rmSync(state.directory, { recursive: true, force: true }))

describe('the signed local port remains an explicit named-job client', () => {
  it('does not fetch or persist on construction and refuses an older observer before activation', async () => {
    const port = createConsoleWorkflowLocalPort()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(readdirSync(state.directory)).toEqual([])
    state.observed = false
    expect(await port.activate(request())).toMatchObject({
      ok: false,
      error: { code: 'capability_unavailable' }
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(readdirSync(state.directory)).toEqual([])
  })

  it('retries a lost activation response with the exact retained IDs only after another explicit start', async () => {
    let claimed: Record<string, string> | null = null
    fetchMock.mockImplementation(async (url, options) => {
      if (String(url).endsWith('/handoff')) {
        return reply({
          ok: true,
          handoff: { ...executionHandoff(), status: claimed ? 'running' : 'queued' },
          workflow_inputs: [],
          blockers: [],
          ready: !claimed
        })
      }
      if (String(url).endsWith('/activate')) {
        const body = JSON.parse(options!.body as string)
        if (!claimed) {
          claimed = body
          throw new Error('The response was lost after the server committed the claim.')
        }
        expect(body).toEqual(claimed)
        const c = executionBinding.claim!
        return reply({
          ok: true,
          handoff: { ...executionHandoff(), status: 'running' },
          workflow_inputs: [],
          claim: {
            job_id: executionBinding.jobId,
            host: c.host,
            attempt: executionBinding.attempt,
            lease_generation: executionBinding.leaseGeneration,
            claimed_at: c.claimedAt,
            ...claimed,
            attempt_intent_id: c.attemptIntentId,
            dispatch_key: c.dispatchKey
          }
        })
      }
      return reply({ ...executionClaimRow(), ...claimed })
    })
    const first = await createConsoleWorkflowLocalPort().activate(request())
    expect(first).toMatchObject({ ok: false, error: { code: 'backoffice_unavailable' } })
    const callsBeforeRestore = fetchMock.mock.calls.length
    const restored = createConsoleWorkflowLocalPort()
    expect(fetchMock).toHaveBeenCalledTimes(callsBeforeRestore)
    expect(await restored.activate(request())).toMatchObject({ ok: true })
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(2)
    for (const [url, options] of fetchMock.mock.calls) {
      expect(String(url)).not.toMatch(/\/runner\/|\/next|\/beat|\/slots|\/seats/)
      expect(options?.body ?? '').not.toContain(sentinel)
    }
    for (const file of readdirSync(join(state.directory, 'console-activation-transport'))) {
      expect(
        readFileSync(join(state.directory, 'console-activation-transport', file), 'utf8')
      ).not.toContain(sentinel)
    }
  })

  it('refuses another generation before accepting its cancellation flag', async () => {
    fetchMock.mockResolvedValue(
      reply({
        ...executionClaimRow(),
        cancel_requested: true,
        lease_generation: executionBinding.leaseGeneration + 1
      })
    )
    expect(
      await createConsoleWorkflowLocalPort().inspect(executionBinding, executionPrincipal)
    ).toMatchObject({ ok: false, error: { code: 'invalid_response' } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
