import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConsoleWorkflowGraph, ConsoleWorkflowJob } from '../../shared/console-workflow-types'
import { currentBearerToken } from './backoffice-auth'
import { getBackofficeSnapshot } from './backoffice-config'
import {
  consoleWorkflowClient as client,
  publishConsoleExecutionObservation,
  getConsolePublicationPrincipal,
  sanitizeConsoleWorkflowText
} from './console-workflow-client'
import { createConsoleWorkflowLocalPort } from './console-workflow-local-port'
import { ensureActiveOrcaProfile } from '../omni-profiles/profile-index-store'
import { getProfileUserDataPath } from '../omni-profiles/profile-storage-paths'
import { isCloudSessionMutationCurrent } from '../omni-profiles/profile-cloud-session-mutation'
import { requestConsoleWorkflow } from './console-workflow-transport'
import { consoleWorkflowJson } from '../../shared/console-workflow-schemas'

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

const credential = 'opaque-person-credential-sentinel'
const baseUrl = 'https://console.example.test'
const workflowId = 'wf_console_graph_audit'
const digest = 'a'.repeat(64)
const graph: ConsoleWorkflowGraph = {
  schema_version: 1,
  mode: 'single_shot',
  title: 'Review',
  prompt: ' Review the candidate. ',
  company: 'example',
  owner: 'emp_audit',
  policy: { auto: false },
  nodes: [
    {
      key: 'review',
      title: 'Review',
      brief: ' Review exactly. ',
      actor_type: 'human',
      actor_id: 'emp_audit',
      action: 'approve',
      after: [],
      owned_paths: null
    }
  ],
  columns: [['review']],
  dispatch_id: workflowId,
  digest
}
const job: ConsoleWorkflowJob = {
  id: 'job_audit0001',
  task_id: 'btk_audit0001',
  node_id: 'btk_audit0001',
  title: 'Review',
  status: 'queued',
  actor_type: 'human',
  provider: null,
  model: null,
  effort: null,
  repo: null,
  machine: null,
  pr_url: null,
  attempt: 0,
  lease_generation: 0,
  owned_paths: null,
  updated_at: '2026-09-08T21:00:00Z',
  policy: {
    workflow: {
      version: 1,
      digest,
      mode: 'single_shot',
      dispatch_id: workflowId,
      key: 'review',
      actor_type: 'human',
      actor_id: 'emp_audit',
      action: 'approve',
      after: [],
      after_keys: [],
      require_merged: [],
      approval_ancestors: []
    }
  },
  blockers: [],
  workflow_state: 'awaiting_human',
  can_decide: true
}
const preview = {
  classification: {
    title: 'Review',
    company_slug: 'example',
    steps: [{ title: 'Review', actor: 'emp_audit', action: 'approve' as const }]
  },
  prompt: 'Review'
}
const admission = {
  graph,
  digest,
  objective: {
    goal_id: 'cgl_audit',
    title: 'Review',
    desired_result: 'Reviewed',
    acceptance_policy: { reviewed: true },
    verification_policy: { independent: true }
  },
  org_unit_id: 'ou_audit',
  expected_authority_epoch: 2
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
  vi.mocked(currentBearerToken).mockResolvedValue(credential)
  vi.mocked(getBackofficeSnapshot).mockReturnValue({ configured: true, env: 'production', baseUrl })
  vi.mocked(getProfileUserDataPath).mockReturnValue('/virtual/profile')
  vi.mocked(ensureActiveOrcaProfile).mockReturnValue({
    profile: { id: 'profile-a', cloud: { userId: 'person-a' } }
  } as never)
  vi.mocked(isCloudSessionMutationCurrent).mockReturnValue(true)
})

describe('signed-person workflow transport', () => {
  it('refuses unlisted routes and methods before reading a signed credential', async () => {
    for (const path of [
      '/api/runner/next',
      '/api/gtd/hub/api/me',
      'https://elsewhere.test',
      '/api/collab/board/btk_audit0001?force=true'
    ]) {
      expect(await requestConsoleWorkflow(path, 'POST', consoleWorkflowJson)).toMatchObject({
        ok: false,
        error: { code: 'invalid_request' }
      })
    }
    expect(fetchMock).not.toHaveBeenCalled()
    expect(currentBearerToken).not.toHaveBeenCalled()
  })
  it('previews through the exact BFF route with a main-only bearer and disabled redirects', async () => {
    reply({ ok: true, graph, digest, workflow_id: workflowId, jobs: [job] })
    const result = await client.preview(preview)
    expect(result.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      `${baseUrl}/api/gtd/workflow-graphs/preview`,
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        credentials: 'omit',
        body: JSON.stringify(preview),
        headers: expect.objectContaining({ Authorization: `Bearer ${credential}` })
      })
    )
    expect(JSON.stringify(result)).not.toContain(credential)
  })
  it('preserves the exact reviewed graph and digest in admission', async () => {
    reply({
      ok: true,
      workflow_id: workflowId,
      jobs: [job],
      receipt: { receipt: { workflow_id: workflowId } }
    })
    expect((await client.admit(admission)).ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      `${baseUrl}/api/gtd/workflow-graphs/admit`,
      expect.objectContaining({
        body: JSON.stringify(admission)
      })
    )
  })
  it('preserves the witnessed card adoption and requires its observed revision', async () => {
    const adopted = {
      ...admission,
      card_id: job.task_id,
      expected_revision: 9,
      adopt_stage: 'review'
    }
    reply({ ok: true, workflow_id: workflowId, jobs: [job], receipt: {} })
    expect((await client.admit(adopted)).ok).toBe(true)
    expect(JSON.parse(fetchMock.mock.calls.at(-1)?.[1]?.body as string)).toEqual(adopted)
    expect(await client.admit({ ...adopted, expected_revision: undefined })).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' }
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('refuses a changed digest, path injection and arbitrary transport fields before authentication', async () => {
    const results = await Promise.all([
      client.admit({ ...admission, digest: 'b'.repeat(64) }),
      client.getWorkflow({ workflowId: '../runner/next' }),
      client.preview({ ...preview, url: 'https://elsewhere.test', headers: {} } as never),
      client.decideHumanAction({
        jobId: 'job_good?force=true',
        decision: 'approve',
        note: 'Reviewed'
      })
    ])
    for (const result of results) {
      expect(result).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    }
    expect(currentBearerToken).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('never sends a credential embedded in user content to the ledger', async () => {
    const result = await client.preview({ ...preview, prompt: `Please save ${credential}` })
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain(credential)
  })
  it('requires a signed person even when a development BFF accepts unauthenticated requests', async () => {
    vi.mocked(currentBearerToken).mockResolvedValue(null)
    expect(await client.listHumanActions()).toMatchObject({
      ok: false,
      error: { code: 'signed_in_required' }
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('refuses a changed connection during token refresh', async () => {
    vi.mocked(getBackofficeSnapshot)
      .mockReturnValueOnce({ configured: true, env: 'production', baseUrl })
      .mockReturnValueOnce({ configured: true, env: 'production', baseUrl })
      .mockReturnValue({ configured: true, env: 'production', baseUrl: 'https://changed.test' })
    expect(await client.listHumanActions()).toMatchObject({
      ok: false,
      error: { code: 'connection_changed' }
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('reads public job fields and sends only the decision and evidence note', async () => {
    reply({ ok: true, workflow_id: workflowId, jobs: [job] })
    expect(await client.getWorkflow({ workflowId })).toMatchObject({
      ok: true,
      data: { jobs: [job] }
    })
    reply({ ok: true, job, hub: { event_id: 'tve_audit' } })
    expect(
      (
        await client.decideHumanAction({
          jobId: job.id,
          decision: 'approve',
          note: 'Evidence reviewed'
        })
      ).ok
    ).toBe(true)
    expect(fetchMock).toHaveBeenLastCalledWith(
      `${baseUrl}/api/gtd/workflow-jobs/${job.id}/decision`,
      expect.objectContaining({
        body: JSON.stringify({ decision: 'approve', note: 'Evidence reviewed' })
      })
    )
  })
  it('dismisses machine decisions through the owner-scoped bulk route, dry run first', async () => {
    reply({
      matched: 3,
      dismissed: 0,
      by_class: { stale_send: 2, crashed_reconcile: 1 },
      dry_run: true
    })
    const preview = await client.dismissMachineDecisions({ dryRun: true })
    expect(preview).toMatchObject({ ok: true, data: { matched: 3, dismissed: 0, dry_run: true } })
    expect(fetchMock).toHaveBeenLastCalledWith(
      `${baseUrl}/api/gtd/hub/api/decisions/bulk-dismiss`,
      expect.objectContaining({ body: JSON.stringify({ scope: 'machine', dry_run: true }) })
    )
    reply({
      matched: 3,
      dismissed: 3,
      by_class: { stale_send: 2, crashed_reconcile: 1 },
      dry_run: false
    })
    const done = await client.dismissMachineDecisions({ dryRun: false, note: 'reset' })
    expect(done).toMatchObject({ ok: true, data: { dismissed: 3 } })
    expect(fetchMock).toHaveBeenLastCalledWith(
      `${baseUrl}/api/gtd/hub/api/decisions/bulk-dismiss`,
      expect.objectContaining({
        body: JSON.stringify({ scope: 'machine', dry_run: false, note: 'reset' })
      })
    )
  })
  it('keeps backend refusals, redacts arbitrary bearer echoes, and makes no automatic retry', async () => {
    reply({ ok: false, error: { code: 'blocked', message: `Wait: ${credential}` } }, 409)
    expect(
      await client.decideHumanAction({ jobId: job.id, decision: 'approve', note: 'Evidence' })
    ).toEqual({
      ok: false,
      error: { code: 'blocked', message: 'Wait: [redacted]', status: 409 }
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('redacts nested successes and encoded tokens without persisting raw responses', async () => {
    reply({
      ok: true,
      workflow_id: workflowId,
      jobs: [
        {
          ...job,
          title: credential,
          policy: {
            ...job.policy,
            human_result: {
              nested: [credential, Buffer.from(credential).toString('base64')],
              access_token: 'private'
            }
          }
        }
      ]
    })
    const result = await client.getWorkflow({ workflowId })
    expect(result.ok).toBe(true)
    expect(JSON.stringify(result)).not.toContain(credential)
    expect(JSON.stringify(result)).not.toContain('private')
    expect(JSON.stringify(result)).not.toContain(Buffer.from(credential).toString('base64'))
  })
  it('continues scrubbing an earlier in-memory credential after token rotation', async () => {
    await getConsolePublicationPrincipal()
    vi.mocked(currentBearerToken).mockResolvedValue('rotated-person-credential')
    expect(await client.preview({ ...preview, prompt: credential })).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' }
    })
    expect(fetchMock).not.toHaveBeenCalled()
    reply({ ok: true, workflow_id: workflowId, jobs: [{ ...job, title: credential }] })
    expect(await client.getWorkflow({ workflowId })).toMatchObject({
      ok: true,
      data: { jobs: [{ title: '[redacted]' }] }
    })
  })
  it('rejects protected frozen graphs rather than altering reviewed content', async () => {
    reply({
      ok: true,
      graph: { ...graph, prompt: credential },
      digest,
      workflow_id: workflowId,
      jobs: []
    })
    expect(await client.preview(preview)).toMatchObject({
      ok: false,
      error: { code: 'invalid_response' }
    })
  })
  it('does not expose exception text, HTML errors, or malformed success payloads', async () => {
    fetchMock.mockRejectedValueOnce(new Error(`transport ${credential}`))
    expect(await client.listHumanActions()).toMatchObject({
      ok: false,
      error: { code: 'backoffice_unavailable' }
    })
    fetchMock.mockResolvedValueOnce(new Response(`<html>${credential}</html>`, { status: 502 }))
    const html = await client.listHumanActions()
    expect(html.ok).toBe(false)
    expect(JSON.stringify(html)).not.toContain(credential)
    reply({ ok: true, jobs: [{}] })
    expect(await client.listHumanActions()).toMatchObject({
      ok: false,
      error: { code: 'invalid_response' }
    })
  })
  // Why: against the live console the Jobs view showed only "does not match this workflow
  // contract" — the failure must name the field so the mismatch can be located.
  it('names the mismatching fields of a malformed success payload, never its values', async () => {
    const { workflow_state: _omitted, ...withoutState } = job
    reply({ ok: true, jobs: [{ ...withoutState, title: credential }] })
    const result = await client.listHumanActions()
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_response' } })
    const message = result.ok ? '' : result.error.message
    expect(message).toContain('jobs.0.workflow_state')
    expect(message).not.toContain(credential)
  })
  it('uses the existing canonical template list and decodes summary identities', async () => {
    reply({
      templates: [
        {
          id: 'wft_audit',
          name: 'Review',
          scope: 'personal',
          status: 'active',
          version: '1',
          body: { description: 'Review work' }
        }
      ]
    })
    expect(await client.templates()).toEqual({
      ok: true,
      data: [
        {
          id: 'wft_audit',
          name: 'Review',
          scope: 'personal',
          status: 'active',
          version: '1',
          description: 'Review work'
        }
      ]
    })
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${baseUrl}/api/gtd/hub/api/workflow-templates`)
  })
  it('honestly refuses absent renderer capabilities without auth or HTTP', async () => {
    const caps = await client.capabilities()
    expect(caps).toMatchObject({
      ok: true,
      data: {
        inventory: { available: false },
        preview: { available: true },
        previewTask: { available: true },
        admitTask: { available: true }
      }
    })
    const results = await Promise.all([
      client.inventory(),
      client.presets(),
      client.listEvents({ workflowId }),
      client.redraft({ workflowId, instruction: 'Revise' }),
      client.saveTemplate({ workflowId, name: 'Saved' }),
      client.exportWorkflow({ workflowId }),
      client.saveReviewSet({ workflowId, name: 'Review' }),
      client.saveChain({ workflowId, name: 'Chain' })
    ])
    for (const result of results) {
      expect(result).toMatchObject({ ok: false, error: { code: 'capability_unavailable' } })
    }
    expect(fetchMock).not.toHaveBeenCalled()
    expect(currentBearerToken).not.toHaveBeenCalled()
  })
  it('refuses incomplete local requests and cursorless publication under a captured matching person', async () => {
    const principal = await getConsolePublicationPrincipal()
    expect(principal).toMatch(/^[a-f0-9]{64}$/)
    const port = createConsoleWorkflowLocalPort()
    const results = await Promise.all([
      port.getReadyJob({} as never),
      port.activate({} as never),
      port.inspect({} as never, principal!),
      port.result({} as never, principal!, {} as never),
      port.cancelled({} as never, principal!),
      publishConsoleExecutionObservation({} as never, principal!)
    ])
    for (const result of results) {
      expect(result).toMatchObject({ ok: false })
      if (!result.ok) {
        expect(['invalid_request', 'capability_unavailable']).toContain(result.error.code)
      }
    }
    expect(fetchMock).not.toHaveBeenCalled()
    expect(sanitizeConsoleWorkflowText(`output ${credential}`)).toBe('output [redacted]')
  })
  it('fences profile switches, session mutations and replay under a different person', async () => {
    const principal = await getConsolePublicationPrincipal()
    vi.mocked(ensureActiveOrcaProfile).mockReturnValue({
      profile: { id: 'profile-b', cloud: { userId: 'person-b' } }
    } as never)
    expect(await publishConsoleExecutionObservation({} as never, principal!)).toMatchObject({
      ok: false,
      error: { code: 'principal_mismatch' }
    })
    vi.mocked(currentBearerToken).mockImplementation(async () => {
      vi.mocked(ensureActiveOrcaProfile).mockReturnValue({
        profile: { id: 'profile-c', cloud: { userId: 'person-c' } }
      } as never)
      return credential
    })
    expect(await client.templates()).toMatchObject({
      ok: false,
      error: { code: 'connection_changed' }
    })
    vi.mocked(currentBearerToken).mockResolvedValue(credential)
    vi.mocked(isCloudSessionMutationCurrent).mockReturnValue(false)
    expect(await getConsolePublicationPrincipal()).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('does not deliver a response into a different signed-in session', async () => {
    fetchMock.mockImplementationOnce(async () => {
      vi.mocked(isCloudSessionMutationCurrent).mockReturnValue(false)
      return new Response(JSON.stringify({ ok: true, jobs: [job] }))
    })
    expect(await client.listHumanActions()).toMatchObject({
      ok: false,
      error: { code: 'connection_changed' }
    })
  })
  it('reads stored job details and events without inventing graph eligibility or local placement', async () => {
    const event = {
      id: 7,
      job_id: job.id,
      kind: 'result',
      detail: { output: credential },
      created_at: '2026-09-08T21:00:00Z'
    }
    const stored = {
      id: job.id,
      task_id: job.task_id,
      title: job.title,
      status: 'queued',
      policy: {},
      brief: 'Do the work',
      acceptance: 'Verified result',
      output_tail: credential,
      events: [event]
    }
    reply(stored)
    const detail = await client.getJob({ jobId: job.id })
    expect(detail).toMatchObject({
      ok: true,
      data: {
        brief: stored.brief,
        acceptance: stored.acceptance,
        output_tail: '[redacted]',
        policy: {}
      }
    })
    expect(detail.ok && detail.data).not.toHaveProperty('can_decide')
    expect(detail.ok && detail.data).not.toHaveProperty('placement')
    reply({ jobs: [stored], review_jobs: [], counts: {} })
    expect((await client.listJobs({ taskId: job.task_id })).ok).toBe(true)
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(`${baseUrl}/api/gtd/jobs?task=${job.task_id}`)
    // Why: the production console listed jobs whose task ids follow the hub's grammar
    // (not `btk_…`); the whole Jobs view went blank on one such row.
    reply({
      jobs: [{ ...stored, task_id: 'task_from_the_hub_1' }, stored],
      review_jobs: [],
      counts: {}
    })
    const mixed = await client.listJobs({})
    expect(mixed.ok).toBe(true)
    expect(mixed.ok && mixed.data.jobs.map((row) => row.task_id)).toEqual([
      'task_from_the_hub_1',
      stored.task_id
    ])
    reply({ job_id: job.id, events: [event] })
    expect(await client.listJobEvents({ jobId: job.id, limit: 50, eventId: 7 })).toMatchObject({
      ok: true,
      data: { events: [{ detail: { output: '[redacted]' } }] }
    })
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(
      `${baseUrl}/api/gtd/jobs/${job.id}/events?limit=50&event_id=7`
    )
  })
  it('sends the observed card revision for edits and completion and preserves stale refusals', async () => {
    reply({
      task: {
        id: job.task_id,
        title: 'Task',
        status: 'open',
        state_revision: 9,
        next_action: 'Review'
      }
    })
    expect(await client.getTask({ taskId: job.task_id })).toMatchObject({
      ok: true,
      data: { state_revision: 9, next_action: 'Review' }
    })
    reply({ ok: true, task_id: job.task_id })
    expect(
      (await client.updateTask({ taskId: job.task_id, expectedRevision: 9, nextAction: 'Verify' }))
        .ok
    ).toBe(true)
    expect(fetchMock.mock.calls.at(-1)).toEqual([
      `${baseUrl}/api/collab/board/${job.task_id}`,
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ expected_revision: 9, next_action: 'Verify' })
      })
    ])
    reply({ error: { code: 'stale_revision', message: 'Refresh card' } }, 409)
    expect(
      await client.requestCompletion({ taskId: job.task_id, expectedRevision: 9 })
    ).toMatchObject({ ok: false, error: { code: 'stale_revision', status: 409 } })
    expect(fetchMock.mock.calls.at(-1)?.[1]?.body).toBe(
      JSON.stringify({ expected_revision: 9, status: 'done' })
    )
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})

describe('persistent Work signed-person operations', () => {
  it('reads the canonical board without accepting renderer routes', async () => {
    reply({
      items: [{ id: 'btk_audit0001', title: 'Review', status: 'open' }],
      total: 1,
      capped: false
    })
    reply({ companies: [] })
    expect(await client.listWork()).toMatchObject({ ok: true, data: { total: 1 } })
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${baseUrl}/api/work/board-all`)
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      'Cache-Control': 'no-cache',
      Authorization: `Bearer ${credential}`
    })
  })
  it('rejects activity belonging to another task and traversal before fetch', async () => {
    reply([
      {
        id: 'event_one',
        task_id: 'btk_other0001',
        actor: 'emp_audit',
        event: 'comment',
        created_at: '2026-09-13',
        note: 'Other task'
      }
    ])
    expect(await client.listTaskActivity({ taskId: 'btk_audit0001' })).toMatchObject({ ok: false })
    fetchMock.mockClear()
    expect(await client.listTaskActivity({ taskId: '../admin' })).toMatchObject({ ok: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('keeps note authorship server owned and never retries a refused write', async () => {
    expect(
      await client.addTaskNote({
        taskId: 'btk_audit0001',
        note: 'A note',
        actor: 'emp_other'
      } as never)
    ).toMatchObject({ ok: false })
    expect(fetchMock).not.toHaveBeenCalled()
    reply({ error: 'not allowed' }, 403)
    expect(await client.addTaskNote({ taskId: 'btk_audit0001', note: 'A note' })).toMatchObject({
      ok: false,
      error: { status: 403 }
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ note: 'A note' })
  })
  it('discards a Work read when the signed person changes', async () => {
    fetchMock.mockImplementationOnce(async () => {
      vi.mocked(isCloudSessionMutationCurrent).mockReturnValue(false)
      return new Response(JSON.stringify({ items: [], total: 0, capped: false }))
    })
    expect(await client.listWork()).toMatchObject({
      ok: false,
      error: { code: 'connection_changed' }
    })
  })
})

it('submits a real blocker with the prepared task revision and preserves stale refusals', async () => {
  reply({ error: 'stale revision' }, 409)
  expect(
    await client.updateTask({
      taskId: 'btk_audit0001',
      expectedRevision: 7,
      blockedReason: 'Candidate unavailable'
    })
  ).toMatchObject({ ok: false, error: { status: 409 } })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
    expected_revision: 7,
    status: 'blocked',
    blocked_reason: 'Candidate unavailable'
  })
  expect(await client.updateTask({ taskId: 'btk_audit0001', expectedRevision: 7 })).toMatchObject({
    ok: false
  })
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

it('moves a card with the hub lifecycle verb, and refuses an action it does not serve', async () => {
  reply({ task: { id: 'btk_audit0001', kanban_status: 'in_progress' } })
  expect(
    await client.transitionTask({
      taskId: 'btk_audit0001',
      action: 'resume',
      expectedRevision: 7
    })
  ).toMatchObject({ ok: true })
  expect(fetchMock.mock.calls[0]?.[0]).toBe(`${baseUrl}/api/collab/board/btk_audit0001/lifecycle`)
  expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST')
  expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
    action: 'resume',
    expected_revision: 7
  })
  // Why: `done` is not a rail verb; the request never leaves the process.
  expect(
    await client.transitionTask({
      taskId: 'btk_audit0001',
      action: 'done' as never,
      expectedRevision: 7
    })
  ).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

it('repairs links through the existing guarded attach verb without creating a task', async () => {
  reply({ session_id: 'ses_audit0001', board_task_id: 'btk_audit0001', changed: true })
  expect(
    await client.attachWorkSession({ sessionId: 'ses_audit0001', taskId: 'btk_audit0001' })
  ).toMatchObject({ ok: true })
  expect(fetchMock.mock.calls[0]?.[0]).toBe(
    `${baseUrl}/api/gtd/hub/api/sessions/ses_audit0001/attach`
  )
  expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
    board_task_id: 'btk_audit0001'
  })
  expect(
    await client.attachWorkSession({ sessionId: '../admin', taskId: 'btk_audit0001' })
  ).toMatchObject({ ok: false })
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

describe('shared task details', () => {
  it('writes explicit clears and ordered steps with the observed revision, then confirms saved fields', async () => {
    reply({ ok: true })
    reply({
      id: 'btk_audit0001',
      title: 'Updated outcome',
      status: 'open',
      state_revision: 8,
      description: '',
      due_date: null,
      priority: 'high',
      sequential_steps: []
    })
    expect(
      await client.updateTask({
        taskId: 'btk_audit0001',
        expectedRevision: 7,
        title: 'Updated outcome',
        description: '',
        dueDate: null,
        priority: 'high',
        sequentialSteps: []
      })
    ).toMatchObject({
      ok: true,
      data: { taskId: 'btk_audit0001', stateRevision: 8, principal: expect.any(String) }
    })
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      expected_revision: 7,
      title: 'Updated outcome',
      description: '',
      due_date: '',
      priority: 'high',
      sequential_steps: []
    })
    expect(String(fetchMock.mock.calls[1][0])).toContain('/api/gtd/hub/api/board/btk_audit0001')
  })

  it.each([
    { id: 'btk_wrong001', title: 'Updated outcome', status: 'open', state_revision: 8 },
    { id: 'btk_audit0001', title: 'Old title', status: 'open', state_revision: 8 },
    { id: 'btk_audit0001', title: 'Updated outcome', status: 'open', state_revision: 6 }
  ])('does not claim success when readback does not confirm the save: %j', async (readback) => {
    reply({ ok: true })
    reply(readback)
    expect(
      await client.updateTask({
        taskId: 'btk_audit0001',
        expectedRevision: 7,
        title: 'Updated outcome'
      })
    ).toMatchObject({ ok: false, error: { code: 'task_save_unconfirmed' } })
  })

  it('never treats an ignored plan update as saved', async () => {
    reply({ ok: true })
    reply({
      id: 'btk_audit0001',
      title: 'Outcome',
      status: 'open',
      state_revision: 8,
      sequential_steps: ['Old plan']
    })
    expect(
      await client.updateTask({
        taskId: 'btk_audit0001',
        expectedRevision: 7,
        sequentialSteps: ['AI drafts', 'Human reviews']
      })
    ).toMatchObject({ ok: false, error: { code: 'task_save_unconfirmed' } })
  })

  it('does not read back or upload after a stale revision refusal', async () => {
    reply({ detail: 'task_revision_stale' }, 409)
    expect(
      await client.updateTask({
        taskId: 'btk_audit0001',
        expectedRevision: 7,
        description: 'New context'
      })
    ).toMatchObject({ ok: false })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('issues its own principal after a signed task read, ignoring remote identity hints', async () => {
    reply({
      id: 'btk_audit0001',
      title: 'Outcome',
      status: 'open',
      state_revision: 7,
      publicationPrincipal: 'remote-invented',
      sequential_steps: ['Review']
    })
    const result = await client.getTask({ taskId: 'btk_audit0001' })
    expect(result).toMatchObject({
      ok: true,
      data: {
        sequential_steps: ['Review'],
        publicationPrincipal: expect.stringMatching(/^[a-f0-9]{64}$/)
      }
    })
  })
})
