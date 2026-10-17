import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConsoleWorkflowJob } from '../../shared/console-workflow-types'
import { currentBearerToken } from './backoffice-auth'
import { getBackofficeSnapshot } from './backoffice-config'
import { consoleWorkflowClient as client } from './console-workflow-client'
import { ensureActiveOrcaProfile } from '../omni-profiles/profile-index-store'
import { getProfileUserDataPath } from '../omni-profiles/profile-storage-paths'
import { isCloudSessionMutationCurrent } from '../omni-profiles/profile-cloud-session-mutation'

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

// Exercise the control contract with a supporting server; production remains gated.
vi.mock('../../shared/fleet-execution-controls', () => ({ fleetExecutionControlsAvailable: true }))

const baseUrl = 'https://console.example.test'
const workflowId = 'wf_console_graph_audit'
const job: ConsoleWorkflowJob = {
  id: 'job_audit0001',
  task_id: 'btk_audit0001',
  node_id: 'btk_audit0001',
  title: 'Build',
  status: 'cancelled',
  actor_type: 'ai',
  provider: 'codex',
  model: 'gpt-6-astra',
  effort: 'high',
  repo: 'Example/project',
  machine: 'mw0003',
  pr_url: null,
  attempt: 1,
  lease_generation: 1,
  owned_paths: null,
  updated_at: '2026-09-15T21:00:00Z',
  policy: {
    workflow: {
      version: 1,
      digest: 'a'.repeat(64),
      mode: 'single_shot',
      dispatch_id: workflowId,
      key: 'build',
      actor_type: 'ai',
      actor_id: 'codex:gpt-6-astra',
      action: 'execute',
      after: [],
      after_keys: [],
      require_merged: [],
      approval_ancestors: []
    }
  },
  blockers: [],
  workflow_state: 'cancelled',
  can_decide: false
}
const fetchMock = vi.fn<typeof fetch>()
function reply(body: unknown, status = 200): void {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  )
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  vi.mocked(currentBearerToken).mockResolvedValue('opaque-person-credential')
  vi.mocked(getBackofficeSnapshot).mockReturnValue({ configured: true, env: 'production', baseUrl })
  vi.mocked(getProfileUserDataPath).mockReturnValue('/virtual/profile')
  vi.mocked(ensureActiveOrcaProfile).mockReturnValue({
    profile: { id: 'profile-a', cloud: { userId: 'person-a' } }
  } as never)
  vi.mocked(isCloudSessionMutationCurrent).mockReturnValue(true)
})

describe('fleet workflow controls', () => {
  it('cancels a whole workflow on its exact route with an empty body', async () => {
    const cancellation = {
      ok: true,
      workflow_id: workflowId,
      jobs: [job],
      cancelled: [job.id],
      cancel_requested: [job.id],
      already_cancelled: [],
      finished: [],
      refused: []
    }
    reply(cancellation)
    expect(await client.cancelWorkflow({ workflowId })).toMatchObject({
      ok: true,
      data: { cancelled: [job.id], cancel_requested: [job.id], jobs: [{ id: job.id }] }
    })
    expect(fetchMock).toHaveBeenLastCalledWith(
      `${baseUrl}/api/gtd/workflow-graphs/${workflowId}/cancel`,
      expect.objectContaining({ body: JSON.stringify({}) })
    )
    // A cancellation of another workflow is not this control's answer.
    reply({ ...cancellation, workflow_id: 'wf_other_graph' })
    expect((await client.cancelWorkflow({ workflowId })).ok).toBe(false)
  })

  it('cancels and retries one stage, keeping only the acknowledged identity and status', async () => {
    reply({
      ok: true,
      job: { id: job.id, status: 'cancelled', policy: { private: 'kept on the server' } },
      cancel_requested: false,
      already_cancelled: true
    })
    expect(await client.cancelJob({ jobId: job.id })).toEqual({
      ok: true,
      data: {
        ok: true,
        job: { id: job.id, status: 'cancelled' },
        cancel_requested: false,
        already_cancelled: true
      }
    })
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(
      `${baseUrl}/api/gtd/workflow-jobs/${job.id}/cancel`
    )
    reply({ ok: true, job: { id: job.id, status: 'queued' } })
    expect(await client.retryJob({ jobId: job.id })).toMatchObject({
      ok: true,
      data: { job: { id: job.id, status: 'queued' } }
    })
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(
      `${baseUrl}/api/gtd/workflow-jobs/${job.id}/retry`
    )
    reply({ ok: true, job: { id: 'job_other0001', status: 'queued' } })
    expect((await client.retryJob({ jobId: job.id })).ok).toBe(false)
  })

  it('keeps a refusal and makes no automatic retry', async () => {
    reply(
      {
        ok: false,
        error: { code: 'predecessor_stopped', message: 'Retry the earlier stage first.' }
      },
      409
    )
    expect(await client.retryJob({ jobId: job.id })).toEqual({
      ok: false,
      error: { code: 'predecessor_stopped', message: 'Retry the earlier stage first.', status: 409 }
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refuses path injection before authentication', async () => {
    const refused = await Promise.all([
      client.cancelWorkflow({ workflowId: '../runner/next' }),
      client.cancelJob({ jobId: 'job_good?force=true' }),
      client.retryJob({ jobId: '../../retry' })
    ])
    for (const result of refused) {
      expect(result).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    }
    expect(currentBearerToken).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports the controls as available capabilities', async () => {
    const caps = await client.capabilities()
    expect(caps).toMatchObject({
      ok: true,
      data: {
        cancelWorkflow: { available: true },
        cancelJob: { available: true },
        retryJob: { available: true }
      }
    })
  })
})
