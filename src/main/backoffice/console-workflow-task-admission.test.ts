import { beforeEach, describe, expect, it, vi } from 'vitest'
import { consoleWorkflowClient as client } from './console-workflow-client'
import { captureConsoleWorkflowPerson } from './console-workflow-person'
import type {
  ConsoleTaskAdmitRequest,
  ConsoleTaskPreviewRequest
} from '../../shared/console-workflow-task-types'
import type { ConsoleWorkflowGraph } from '../../shared/console-workflow-types'

vi.mock('./console-workflow-person', () => ({
  captureConsoleWorkflowPerson: vi.fn(),
  redactConsoleWorkflowMemory: (value: unknown) => value,
  getConsolePublicationPrincipal: vi.fn(),
  sanitizeConsoleWorkflowText: (value: string) => value
}))

const fetchMock = vi.fn<typeof fetch>()
const isCurrent = vi.fn(() => true)
const taskId = 'btk_admission1234'
const commands = [
  { program: 'node', args: ['test.js', ' spaced argument ', ''], timeout_ms: 60_000 }
]
const graph: ConsoleWorkflowGraph = {
  schema_version: 1,
  mode: 'single_shot',
  title: 'Build',
  prompt: ' Exact prompt\n',
  company: 'example',
  owner: 'emp_sal',
  policy: { auto: false },
  dispatch_id: 'wf_console_graph_audit',
  digest: 'a'.repeat(64),
  columns: [['build']],
  nodes: [
    {
      key: 'build',
      title: 'Build',
      brief: ' Exact brief\n',
      actor_type: 'ai',
      actor_id: 'codex:gpt-6-astra',
      action: 'execute',
      after: [],
      owned_paths: ['src/**'],
      provider: 'codex',
      model: 'gpt-6-astra',
      repo: 'Example/project',
      placement: 'local',
      acceptance_commands: commands
    }
  ]
}
const input: ConsoleTaskPreviewRequest = {
  taskId,
  expectedRevision: 7,
  placement: 'local',
  prompt: ' Exact prompt\n',
  classification: {
    title: 'Build',
    company_slug: 'example',
    repo: 'Example/project',
    execution_mode: 'sequential',
    steps: [
      {
        key: 'build',
        title: 'Build',
        brief: 'Exact brief',
        actor_type: 'ai',
        actor_id: 'codex:gpt-6-astra',
        action: 'execute',
        after: [],
        acceptance_commands: commands
      }
    ]
  }
}
const admission: ConsoleTaskAdmitRequest = {
  taskId,
  expectedRevision: 7,
  placement: 'local',
  graph,
  digest: graph.digest,
  adoptStage: 'build',
  orgUnitId: 'ou_dev',
  expectedAuthorityEpoch: 3,
  objective: {
    goal_id: 'cgl_existing',
    title: 'Objective',
    desired_result: 'Shipped',
    acceptance_policy: { required: ['all_selected_nodes_verified'] },
    verification_policy: { schema_version: 1 }
  }
}
const admittedJob = {
  id: 'job_admission1234',
  task_id: taskId,
  node_id: taskId,
  title: 'Build',
  status: 'queued',
  actor_type: 'ai',
  provider: 'codex',
  model: 'gpt-6-astra',
  effort: null,
  repo: 'Example/project',
  machine: null,
  pr_url: null,
  attempt: 0,
  lease_generation: 0,
  owned_paths: ['src/**'],
  updated_at: null,
  policy: {
    workflow: {
      version: 1,
      digest: graph.digest,
      mode: graph.mode,
      dispatch_id: graph.dispatch_id,
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
  workflow_state: 'ready',
  can_decide: false
}

function reply(value: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(value), { status }))
}
function replyTask(revision = 7) {
  reply({ task: { id: taskId, title: 'Existing task', status: 'ready', state_revision: revision } })
}
function replyPreview(frozen = graph) {
  reply({
    ok: true,
    graph: frozen,
    digest: frozen.digest,
    workflow_id: frozen.dispatch_id,
    jobs: []
  })
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  isCurrent.mockReturnValue(true)
  vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({
    ok: true,
    data: {
      bearer: 'opaque-admission-test-credential',
      baseUrl: 'https://console.example.test',
      principal: 'person-a',
      isCurrent
    }
  } as never)
})

describe('task-bound canonical graph admission', () => {
  it('reads the exact task revision then previews explicit placement and argv through the existing route', async () => {
    replyTask()
    replyPreview()
    expect(await client.previewTask(input)).toMatchObject({ ok: true, data: { graph } })
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `https://console.example.test/api/gtd/hub/api/board/${taskId}`,
      'https://console.example.test/api/gtd/workflow-graphs/preview'
    ])
    expect(JSON.parse(fetchMock.mock.calls[1][1]!.body as string)).toEqual({
      prompt: input.prompt,
      classification: {
        ...input.classification,
        steps: [{ ...input.classification.steps[0], placement: 'local' }]
      }
    })
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ redirect: 'error', credentials: 'omit' })
  })
  it('refuses stale task revision without previewing and never retries', async () => {
    replyTask(8)
    expect(await client.previewTask(input)).toMatchObject({
      ok: false,
      error: { code: 'stale_revision' }
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })
  it('stops when the captured person changes between task read and preview', async () => {
    replyTask()
    isCurrent.mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(false)
    expect(await client.previewTask(input)).toMatchObject({
      ok: false,
      error: { code: 'connection_changed' }
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })
  it('refuses server previews that drop commands, change placement or add parallel execution', async () => {
    for (const frozen of [
      { ...graph, nodes: [{ ...graph.nodes[0], acceptance_commands: [] }] },
      { ...graph, nodes: [{ ...graph.nodes[0], placement: 'fleet' as const }] },
      { ...graph, mode: 'parallel' as const }
    ]) {
      replyTask()
      replyPreview(frozen)
      expect(await client.previewTask(input)).toMatchObject({
        ok: false,
        error: { code: 'invalid_response' }
      })
    }
    expect(fetchMock).toHaveBeenCalledTimes(6)
  })
  it('sends the exact frozen graph and explicit adoption/policies without activating a job', async () => {
    reply({
      ok: true,
      workflow_id: graph.dispatch_id,
      jobs: [admittedJob],
      receipt: { sealed: true }
    })
    expect(await client.admitTask(admission)).toMatchObject({ ok: true })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://console.example.test/api/gtd/workflow-graphs/admit'
    )
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toEqual({
      graph,
      digest: graph.digest,
      card_id: taskId,
      expected_revision: 7,
      adopt_stage: 'build',
      objective: admission.objective,
      org_unit_id: 'ou_dev',
      expected_authority_epoch: 3
    })
  })
  it('rejects missing authority, invalid adoption and changed digest before reading credentials', async () => {
    for (const value of [
      { ...admission, expectedAuthorityEpoch: undefined },
      { ...admission, adoptStage: 'absent' },
      { ...admission, digest: 'b'.repeat(64) },
      { ...admission, expectedRevision: -1 },
      { ...admission, objective: { ...admission.objective, acceptance_policy: {} } },
      {
        ...admission,
        graph: { ...graph, nodes: [{ ...graph.nodes[0], acceptance_commands: undefined }] }
      }
    ]) {
      expect(await client.admitTask(value as never)).toMatchObject({
        ok: false,
        error: { code: 'invalid_request' }
      })
    }
    expect(captureConsoleWorkflowPerson).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('returns canonical admission refusals without retry or fallback', async () => {
    reply(
      { ok: false, error: { code: 'stale_authority_epoch', message: 'Refresh authority' } },
      409
    )
    expect(await client.admitTask(admission)).toMatchObject({
      ok: false,
      error: { code: 'stale_authority_epoch', status: 409 }
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })
  it('does not report success when the admitted stage is bound to a different task', async () => {
    reply({
      ok: true,
      workflow_id: graph.dispatch_id,
      jobs: [{ ...admittedJob, task_id: 'btk_other1234' }],
      receipt: {}
    })
    expect(await client.admitTask(admission)).toMatchObject({
      ok: false,
      error: { code: 'invalid_response' }
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })
  it('keeps unsupported template application unavailable before authentication', async () => {
    expect(await client.previewTask({ ...input, templateId: 'template_1' })).toMatchObject({
      ok: false,
      error: { code: 'capability_unavailable' }
    })
    expect(captureConsoleWorkflowPerson).not.toHaveBeenCalled()
  })
})
