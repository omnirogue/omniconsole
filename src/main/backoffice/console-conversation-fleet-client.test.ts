import {
  createConversationFleetClientFixture,
  source,
  taskId
} from './conversation-fleet-client-test-fixture'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { consoleWorkflowClient } from './console-workflow-client'
import {
  admitConsoleConversationFleetTask,
  hasReviewedFleetAdmission
} from './console-conversation-fleet-client'
// Transport contract tests; durable admission and restart coverage lives in console-fleet-durability.test.
const client = { ...consoleWorkflowClient, admitFleetTask: admitConsoleConversationFleetTask }
import { captureConsoleWorkflowPerson } from './console-workflow-person'
import type {
  ConsoleConversationFleetAdmitRequest,
  ConsoleConversationFleetPreviewRequest
} from '../../shared/console-conversation-fleet-types'
import type { ConsoleWorkflowGraph, ConsoleWorkflowJob } from '../../shared/console-workflow-types'
import {
  appendConversationFleetTestDelivery,
  onlyConversationFleetTestDelivery,
  addConversationFleetTestRecipient
} from './console-conversation-fleet-delivery-test-fixture'

vi.mock('./console-workflow-person', () => ({
  captureConsoleWorkflowPerson: vi.fn(),
  redactConsoleWorkflowMemory: (value: unknown) => value,
  getConsolePublicationPrincipal: vi.fn(),
  sanitizeConsoleWorkflowText: (value: string) => value
}))

const fetchMock = vi.fn<typeof fetch>()
const isCurrent = vi.fn(() => true)
const baseUrl = 'https://console.example.test'
let input: ConsoleConversationFleetPreviewRequest
let graph: ConsoleWorkflowGraph
let admittedJob: ConsoleWorkflowJob
let admission: ConsoleConversationFleetAdmitRequest

function reply(value: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(value), { status }))
}
function preview(frozen = graph) {
  return {
    ok: true,
    graph: frozen,
    digest: frozen.digest,
    workflow_id: frozen.dispatch_id,
    jobs: [],
    admission: {
      task_id: taskId,
      expected_revision: 7,
      context_digest: 'c'.repeat(64),
      adopt_stage: admission.adoptStage
    },
    filing: { company_slug: 'example', org_unit_id: 'ou_dev', goal_id: 'goal_1234' },
    reviewer: { provider: 'codex', model: 'gpt-6-astra', effort: 'high' }
  }
}

function appendDelivery(): ConsoleWorkflowJob {
  return appendConversationFleetTestDelivery(input, graph, admittedJob, source, taskId)
}

function onlyDelivery(): ConsoleWorkflowJob {
  return onlyConversationFleetTestDelivery(input, graph, admittedJob, source, taskId, admission)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  isCurrent.mockReturnValue(true)
  vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({
    ok: true,
    data: {
      bearer: 'opaque-fleet-credential',
      baseUrl,
      principal: 'person-a',
      clerkUserId: 'user_fleet',
      isCurrent
    }
  } as never)
  ;({ input, graph, admittedJob, admission } = createConversationFleetClientFixture())
})

it('requires a current exact preview before authorizing durable admission intent', async () => {
  expect(hasReviewedFleetAdmission(admission)).toBe(false)
  reply(preview())
  expect((await client.previewFleetTask(input)).ok).toBe(true)
  expect(hasReviewedFleetAdmission(admission)).toBe(true)
  expect(
    hasReviewedFleetAdmission({ ...admission, expectedRevision: admission.expectedRevision + 1 })
  ).toBe(false)
  isCurrent.mockReturnValue(false)
  expect(hasReviewedFleetAdmission(admission)).toBe(false)
})

describe('conversation fleet bridge', () => {
  it('retains only explicitly selected source deliverables and the approved summary for an initial person delivery', async () => {
    const delivery = onlyDelivery()
    const selected = {
      kind: 'task_file' as const,
      task_id: taskId,
      file: {
        rel: 'uploads/result.txt',
        name: 'result.txt',
        sha256: 'f'.repeat(64),
        size_bytes: 20
      },
      target_path: 'result.txt'
    }
    const summary = {
      kind: 'task_file' as const,
      task_id: taskId,
      file: {
        rel: 'uploads/summary.md',
        name: 'summary.md',
        sha256: 'e'.repeat(64),
        size_bytes: 40
      }
    }
    const transcript = {
      kind: 'task_file' as const,
      task_id: taskId,
      file: {
        rel: 'uploads/private.json',
        name: 'private.json',
        sha256: 'd'.repeat(64),
        size_bytes: 100
      }
    }
    input.sourceFiles = [selected, summary, transcript]
    input.sourceSummaryFile = summary
    const step = input.classification.steps[0]
    const node = graph.nodes[0]
    step.person_handoff = {
      ...step.person_handoff!,
      include_summary: true,
      deliverables: { kind: 'files', paths: ['result.txt'] },
      source_files: [selected],
      summary_file: summary
    }
    node.person_handoff = {
      ...step.person_handoff,
      source_files: [selected],
      participants: node.person_handoff!.participants
    }
    node.mechanical_execution!.input = { person_handoff: node.person_handoff }
    Object.assign(delivery.policy.workflow, {
      person_handoff: node.person_handoff,
      mechanical_execution: {
        ...node.mechanical_execution,
        input: { person_handoff: node.person_handoff, job_id: delivery.id }
      }
    })
    reply(preview())
    expect(await client.previewFleetTask(input)).toMatchObject({ ok: true })
    reply({ ok: true, workflow_id: graph.dispatch_id, jobs: [delivery], receipt: {} })
    expect(await client.admitFleetTask(admission)).toMatchObject({ ok: true })
    const sent = JSON.parse(fetchMock.mock.calls[0][1]!.body as string)
    expect(sent.source_summary_file).toEqual(summary)
    expect(sent.classification.steps[0].person_handoff.source_files).toEqual([selected])
    expect(sent.classification.steps[0].person_handoff.summary_file).toEqual(summary)
    const admitted = JSON.parse(fetchMock.mock.calls[1][1]!.body as string)
    expect(admitted.adopt_stage).toBeNull()
    expect(delivery.task_id).not.toBe(taskId)
    expect(delivery.policy.workflow.source_task_id).toBe(taskId)
    expect(delivery.policy.workflow.person_handoff!.task_id).toBe(taskId)
  })

  it('admits the exact mechanical person delivery without making a human decision or sending a message from the IDE', async () => {
    const delivery = appendDelivery()
    reply(preview())
    expect(await client.previewFleetTask(input)).toMatchObject({ ok: true })
    reply({ ok: true, workflow_id: graph.dispatch_id, jobs: [admittedJob, delivery], receipt: {} })
    expect(await client.admitFleetTask(admission)).toMatchObject({ ok: true })
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${baseUrl}/api/gtd/workflow-tasks/${taskId}/preview`,
      `${baseUrl}/api/gtd/workflow-tasks/${taskId}/admit`
    ])
    const sent = JSON.parse(fetchMock.mock.calls[1][1]!.body as string)
    expect(sent.graph.nodes[1].person_handoff).toEqual(graph.nodes[1].person_handoff)
    expect(sent.graph.nodes[1].mechanical_execution).toEqual(graph.nodes[1].mechanical_execution)
  })

  it.each(['wrong-source', 'missing-source', 'adopted-source'] as const)(
    'refuses a delivery-only admission with %s task binding',
    async (change) => {
      const delivery = onlyDelivery()
      reply(preview())
      expect(await client.previewFleetTask(input)).toMatchObject({ ok: true })
      if (change === 'wrong-source') {
        delivery.policy.workflow.source_task_id = 'btk_wrong1234'
      } else if (change === 'missing-source') {
        delete delivery.policy.workflow.source_task_id
      } else {
        delivery.task_id = taskId
      }
      reply({ ok: true, workflow_id: graph.dispatch_id, jobs: [delivery], receipt: {} })
      expect(await client.admitFleetTask(admission)).toMatchObject({
        ok: false,
        error: { code: 'invalid_response' }
      })
    }
  )

  it.each(['delivery-adopts', 'agent-unbound'] as const)(
    'refuses the unsafe %s preview adoption policy',
    async (change) => {
      if (change === 'delivery-adopts') {
        onlyDelivery()
        admission.adoptStage = 'deliver'
      } else {
        admission.adoptStage = null
      }
      const context = graph.policy.conversation_dispatch as Record<string, unknown>
      context.admission = { context_digest: 'c'.repeat(64), adopt_stage: admission.adoptStage }
      reply(preview())
      expect(await client.previewFleetTask(input)).toMatchObject({
        ok: false,
        error: { code: 'invalid_response' }
      })
      expect(await client.admitFleetTask(admission)).toMatchObject({
        ok: false,
        error: { code: 'invalid_request' }
      })
      expect(fetchMock).toHaveBeenCalledOnce()
    }
  )

  it('retries the exact delivery-only workflow after a lost admission response', async () => {
    const delivery = onlyDelivery()
    reply(preview())
    expect(await client.previewFleetTask(input)).toMatchObject({ ok: true })
    fetchMock.mockRejectedValueOnce(new Error('The admission response was lost.'))
    expect(await client.admitFleetTask(admission)).toMatchObject({
      ok: false,
      error: { code: 'backoffice_unavailable' }
    })
    reply({ ok: true, workflow_id: graph.dispatch_id, jobs: [delivery], receipt: {} })
    expect(await client.admitFleetTask(admission)).toMatchObject({ ok: true })
    expect(fetchMock.mock.calls[1][1]!.body).toBe(fetchMock.mock.calls[2][1]!.body)
    expect(JSON.parse(fetchMock.mock.calls[2][1]!.body as string)).toMatchObject({
      expected_revision: 7,
      adopt_stage: null,
      graph: { dispatch_id: graph.dispatch_id, digest: graph.digest }
    })
  })

  it('requires a separate new task for every person delivery stage', async () => {
    const delivery = onlyDelivery()
    const second = addConversationFleetTestRecipient(input, graph, delivery)
    reply(preview())
    expect(await client.previewFleetTask(input)).toMatchObject({ ok: true })
    reply({ ok: true, workflow_id: graph.dispatch_id, jobs: [delivery, second], receipt: {} })
    expect(await client.admitFleetTask(admission)).toMatchObject({ ok: true })
    second.task_id = delivery.task_id
    reply({ ok: true, workflow_id: graph.dispatch_id, jobs: [delivery, second], receipt: {} })
    expect(await client.admitFleetTask(admission)).toMatchObject({
      ok: false,
      error: { code: 'invalid_response' }
    })
  })

  it.each([
    'recipient',
    'director',
    'deliverables',
    'due_at',
    'report',
    'handler',
    'handler-input'
  ] as const)('refuses a person preview that changes %s', async (field) => {
    appendDelivery()
    const changed = structuredClone(graph)
    const person = changed.nodes[1].person_handoff!
    if (field === 'recipient') {
      person.participants.recipient.employee_id = 'emp_someone'
    }
    if (field === 'director') {
      person.participants.director.clerk_user_id = 'user_someone'
    }
    if (field === 'deliverables') {
      person.deliverables = { kind: 'files', paths: ['private-transcript.json'] }
    }
    if (field === 'due_at') {
      person.due_at = '2026-10-01'
    }
    if (field === 'report') {
      changed.nodes[0].handoff_report!.outputs[0].path = 'private-transcript.json'
    }
    if (field === 'handler') {
      changed.nodes[1].mechanical_execution!.handler_digest = 'a'.repeat(64)
    }
    if (field === 'handler-input') {
      changed.nodes[1].mechanical_execution!.input = { job_id: 'job_wrong1234' }
    }
    reply(preview(changed))
    expect(await client.previewFleetTask(input)).toMatchObject({
      ok: false,
      error: { code: 'invalid_response' }
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('refuses an admitted person handler bound to another job', async () => {
    const delivery = appendDelivery()
    reply(preview())
    expect(await client.previewFleetTask(input)).toMatchObject({ ok: true })
    delivery.policy.workflow.mechanical_execution!.input.job_id = 'job_other1234'
    reply({ ok: true, workflow_id: graph.dispatch_id, jobs: [admittedJob, delivery], receipt: {} })
    expect(await client.admitFleetTask(admission)).toMatchObject({
      ok: false,
      error: { code: 'invalid_response' }
    })
  })

  it('requires an approved delivery payload and refuses generic human or mechanical substitutions before authentication', async () => {
    appendDelivery()
    for (const replacement of [
      { ...input.classification.steps[1], actor_type: 'human' },
      { ...input.classification.steps[1], actor_id: 'stop_rule:other' },
      {
        ...input.classification.steps[1],
        person_handoff: { ...input.classification.steps[1].person_handoff, approved: false }
      }
    ]) {
      expect(
        await client.previewFleetTask({
          ...input,
          classification: {
            ...input.classification,
            steps: [input.classification.steps[0], replacement]
          }
        } as never)
      ).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    }
    expect(fetchMock).not.toHaveBeenCalled()
    expect(captureConsoleWorkflowPerson).not.toHaveBeenCalled()
  })

  it('keeps server-scoped conversation discovery explicit and does not invent negotiation on older responses', async () => {
    reply({ jobs: [], conversation_source_scope: 'directing_person' })
    expect(await client.listJobs({ conversationSource: true })).toEqual({
      ok: true,
      data: { jobs: [], conversation_source_scope: 'directing_person' }
    })
    expect(fetchMock.mock.calls[0][0]).toBe(`${baseUrl}/api/gtd/jobs?conversation_source=true`)
    reply({ jobs: [] })
    expect(await client.listJobs({ conversationSource: true })).toEqual({
      ok: true,
      data: { jobs: [] }
    })
    expect(fetchMock.mock.calls[1][0]).toBe(`${baseUrl}/api/gtd/jobs?conversation_source=true`)
    expect(await client.listJobs({ taskId, conversationSource: true })).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' }
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each([true, false, undefined] as const)(
    'preserves advertised source_snapshot=%s without exposing credentials',
    async (sourceSnapshot) => {
      const capability = {
        provider: 'codex',
        models: ['gpt-6-astra'],
        efforts: ['high'],
        available: true,
        resume: true,
        readonly: true,
        native_execution: true,
        pinned_task_inputs: true,
        ...(sourceSnapshot === undefined ? {} : { source_snapshot: sourceSnapshot }),
        folder_workspace: true,
        retained_outputs: true
      }
      reply({
        ok: true,
        providers: ['codex'],
        models: [],
        people: [],
        repositories: [],
        models_fallback: false,
        machines: [
          {
            host: 'mw0003',
            allowed: true,
            ready: true,
            last_beat: '2026-09-12T18:00:00Z',
            slots: 4,
            running: 1,
            execution_capabilities: [capability],
            credential: 'not-public'
          }
        ]
      })
      const result = await client.fleetInventory()
      expect(result).toMatchObject({
        ok: true,
        data: { machines: [{ execution_capabilities: [capability] }] }
      })
      if (result.ok) {
        expect(result.data.machines[0]).not.toHaveProperty('credential')
        expect(result.data.machines[0]!.execution_capabilities).toEqual([capability])
      }
      expect(fetchMock.mock.calls[0][0]).toBe(`${baseUrl}/api/gtd/workflow-dispatch-inventory`)
    }
  )

  it('reads the server task filing, including explicit task setup refusals', async () => {
    reply({
      ok: true,
      task_id: taskId,
      expected_revision: 7,
      supported: false,
      filing: { company_slug: 'example', org_unit_id: null, goal_id: null },
      reason: 'Complete task filing.'
    })
    expect(await client.fleetTaskContext({ taskId })).toMatchObject({
      ok: true,
      data: { supported: false, reason: 'Complete task filing.' }
    })
    expect(fetchMock.mock.calls[0][0]).toBe(`${baseUrl}/api/gtd/workflow-tasks/${taskId}/context`)
  })

  it('previews the selected fleet machine and byte-preserved conversation through the signed person transport', async () => {
    reply(preview())
    expect(await client.previewFleetTask(input)).toMatchObject({ ok: true, data: { graph } })
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, request] = fetchMock.mock.calls[0]
    expect(url).toBe(`${baseUrl}/api/gtd/workflow-tasks/${taskId}/preview`)
    expect(request).toMatchObject({
      redirect: 'error',
      credentials: 'omit',
      headers: { Authorization: 'Bearer opaque-fleet-credential' }
    })
    expect(JSON.parse(request!.body as string)).toEqual({
      expected_revision: 7,
      classification: input.classification,
      prompt: input.prompt,
      fanout_ack: false,
      source
    })
  })

  it('admits only the exact reviewed graph and server task context without activating local execution', async () => {
    reply(preview())
    expect(await client.previewFleetTask(input)).toMatchObject({ ok: true })
    reply({
      ok: true,
      workflow_id: graph.dispatch_id,
      jobs: [admittedJob],
      receipt: { sealed: true }
    })
    expect(await client.admitFleetTask(admission)).toMatchObject({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toBe(`${baseUrl}/api/gtd/workflow-tasks/${taskId}/admit`)
    expect(JSON.parse(fetchMock.mock.calls[1][1]!.body as string)).toEqual({
      graph,
      digest: graph.digest,
      expected_revision: 7,
      context_digest: 'c'.repeat(64),
      adopt_stage: 'review'
    })
  })

  it('preserves exact uploaded file pins, executable mode and deletions in every fleet stage', async () => {
    const pin = {
      kind: 'task_file' as const,
      task_id: taskId,
      file: { rel: 'uploads/run.sh', name: 'run.sh', sha256: 'f'.repeat(64), size_bytes: 100 },
      target_path: 'scripts/run.sh',
      executable: true
    }
    input.sourceFiles = [pin]
    input.sourceDeletions = ['src/removed.ts']
    const frozen = structuredClone(graph)
    frozen.nodes[0].source_files = [pin]
    frozen.nodes[0].source_deletions = input.sourceDeletions
    frozen.nodes[0].source_overlay = true
    reply(preview(frozen))
    expect(await client.previewFleetTask(input)).toMatchObject({ ok: true })
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toMatchObject({
      source_files: [pin],
      source_deletions: ['src/removed.ts']
    })
    frozen.nodes[0].source_overlay = false
    reply(preview(frozen))
    expect(await client.previewFleetTask(input)).toMatchObject({
      ok: false,
      error: { code: 'invalid_response' }
    })
    reply(preview())
    expect(await client.previewFleetTask(input)).toMatchObject({
      ok: false,
      error: { code: 'invalid_response' }
    })
    expect(
      await client.previewFleetTask({
        ...input,
        sourceFiles: [{ ...pin, target_path: '../outside.sh' }]
      })
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' }
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('keeps a folder session in the selected host allocation without inventing a Git repository', async () => {
    const workspace = { kind: 'folder' as const, host: 'mw0003', allocation: 'job' as const }
    input.classification.workspace = workspace
    const step = input.classification.steps[0]
    step.workspace = workspace
    delete step.repo
    delete step.base_branch
    delete step.base_sha
    Object.assign(graph.nodes[0], { workspace, repo: null, base_branch: null })
    delete graph.nodes[0].base_sha
    reply(preview())
    expect(await client.previewFleetTask(input)).toMatchObject({ ok: true })
    admittedJob.repo = null
    admittedJob.policy.workflow.workspace = workspace
    delete admittedJob.policy.workflow.base_sha
    reply({ ok: true, workflow_id: graph.dispatch_id, jobs: [admittedJob], receipt: {} })
    expect(await client.admitFleetTask(admission)).toMatchObject({ ok: true })
  })

  it.each(['machine', 'brief', 'source', 'context', 'digest'] as const)(
    'refuses a preview that changes %s',
    async (field) => {
      const changed = structuredClone(preview())
      if (field === 'machine') {
        changed.graph.nodes[0].machine = 'mw0004'
      }
      if (field === 'brief') {
        changed.graph.nodes[0].brief += '\nAdditional unreviewed instructions'
      }
      if (field === 'source') {
        changed.graph.policy.conversation_dispatch = { source: { session_ref: 'someone-else' } }
      }
      if (field === 'context') {
        changed.admission.context_digest = 'b'.repeat(64)
      }
      if (field === 'digest') {
        changed.digest = 'a'.repeat(64)
      }
      reply(changed)
      expect(await client.previewFleetTask(input)).toMatchObject({
        ok: false,
        error: { code: 'invalid_response' }
      })
      expect(await client.admitFleetTask(admission)).toMatchObject({
        ok: false,
        error: { code: 'preview_required' }
      })
      expect(fetchMock).toHaveBeenCalledOnce()
    }
  )

  it('refuses graph edits, stale reviewed context and a changed signed-in person before admission', async () => {
    reply(preview())
    expect(await client.previewFleetTask(input)).toMatchObject({ ok: true })
    for (const changed of [
      { ...admission, graph: { ...graph, prompt: 'changed' } },
      { ...admission, contextDigest: 'b'.repeat(64) },
      { ...admission, expectedRevision: 8 }
    ]) {
      expect(await client.admitFleetTask(changed)).toMatchObject({
        ok: false,
        error: { code: 'preview_required' }
      })
    }
    isCurrent.mockReturnValue(false)
    expect(await client.admitFleetTask(admission)).toMatchObject({
      ok: false,
      error: { code: 'preview_required' }
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('refuses admission responses bound to another task or machine', async () => {
    reply(preview())
    expect(await client.previewFleetTask(input)).toMatchObject({ ok: true })
    for (const job of [
      { ...admittedJob, task_id: 'btk_other1234' },
      {
        ...admittedJob,
        policy: { workflow: { ...admittedJob.policy.workflow, machine: 'mw0004' } }
      }
    ]) {
      reply({ ok: true, workflow_id: graph.dispatch_id, jobs: [job], receipt: {} })
      expect(await client.admitFleetTask(admission)).toMatchObject({
        ok: false,
        error: { code: 'invalid_response' }
      })
    }
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('checks the original preview identity again after asynchronous credential capture', async () => {
    reply(preview())
    expect(await client.previewFleetTask(input)).toMatchObject({ ok: true })
    vi.mocked(captureConsoleWorkflowPerson).mockImplementationOnce(async () => {
      isCurrent.mockReturnValue(false)
      return {
        ok: true,
        data: {
          bearer: 'opaque-fleet-credential',
          baseUrl,
          principal: 'person-a',
          isCurrent: () => true
        }
      } as never
    })
    expect(await client.admitFleetTask(admission)).toMatchObject({
      ok: false,
      error: { code: 'connection_changed' }
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('never falls back when the task authority refuses admission', async () => {
    reply(preview())
    expect(await client.previewFleetTask(input)).toMatchObject({ ok: true })
    reply({ ok: false, error: { code: 'admission_changed', message: 'Preview again.' } }, 409)
    expect(await client.admitFleetTask(admission)).toMatchObject({
      ok: false,
      error: { code: 'admission_changed', status: 409 }
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('rejects local execution, malformed hosts and unacknowledged fanout before credentials', async () => {
    for (const classification of [
      {
        ...input.classification,
        steps: [{ ...input.classification.steps[0], placement: 'local' }]
      },
      {
        ...input.classification,
        steps: [{ ...input.classification.steps[0], machine: 'HOST_name' }]
      },
      { ...input.classification, steps: [{ ...input.classification.steps[0], effort: ' high ' }] },
      {
        ...input.classification,
        execution_mode: 'parallel',
        steps: [
          input.classification.steps[0],
          { ...input.classification.steps[0], key: 'review-2' }
        ]
      }
    ]) {
      expect(await client.previewFleetTask({ ...input, classification } as never)).toMatchObject({
        ok: false,
        error: { code: 'invalid_request' }
      })
    }
    expect(fetchMock).not.toHaveBeenCalled()
    expect(captureConsoleWorkflowPerson).not.toHaveBeenCalled()
  })
})
