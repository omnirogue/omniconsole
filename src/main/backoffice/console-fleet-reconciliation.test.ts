import { beforeEach, expect, it, vi } from 'vitest'
import { admitRetainedFleetTask } from './console-conversation-fleet-client'
import { captureConsoleWorkflowPerson } from './console-workflow-person'
import {
  createConversationFleetClientFixture,
  taskId
} from './conversation-fleet-client-test-fixture'

vi.mock('./console-workflow-person', () => ({
  captureConsoleWorkflowPerson: vi.fn(),
  redactConsoleWorkflowMemory: (value: unknown) => value
}))
const fetchMock = vi.fn<typeof fetch>()
const isCurrent = vi.fn(() => true)
const baseUrl = 'https://console.example.test'
let fixture = createConversationFleetClientFixture()
let { graph, admittedJob, admission } = fixture
function reply(value: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(value), { status }))
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  isCurrent.mockReturnValue(true)
  vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({
    ok: true,
    data: {
      bearer: 'fixture-token',
      baseUrl,
      principal: 'person-a',
      clerkUserId: 'user_fleet',
      isCurrent
    }
  } as never)
  fixture = createConversationFleetClientFixture()
  ;({ graph, admittedJob, admission } = fixture)
})

function reconciliationProof() {
  return {
    contract: 'conversation-admission-reconciliation.v1',
    task_id: taskId,
    workflow_id: graph.dispatch_id,
    digest: admission.digest,
    expected_revision: 7,
    context_digest: admission.contextDigest,
    command_id: 'canonical-command',
    graph_key: 'canonical-command'
  }
}

it('recovers the exact retained approval only through the explicitly supported canonical endpoint', async () => {
  reply({
    ok: true,
    contract: 'conversation-admission-reconciliation.v1',
    task_id: taskId,
    canonical_command_replay: true
  })
  reply({
    ok: true,
    workflow_id: graph.dispatch_id,
    jobs: [admittedJob],
    receipt: { canonical: true },
    reconciliation: reconciliationProof()
  })
  const { nodes, ...rest } = graph
  const retained = { ...admission, graph: { nodes, ...rest } }
  expect(await admitRetainedFleetTask(retained, isCurrent, true)).toMatchObject({
    ok: true,
    data: { receipt: { canonical: true } }
  })
  expect(fetchMock).toHaveBeenCalledTimes(2)
  const [url, init] = fetchMock.mock.calls[1]
  expect(url).toBe(`${baseUrl}/api/gtd/workflow-tasks/${taskId}/reconcile`)
  expect(JSON.parse(String(init!.body))).toEqual({
    graph,
    digest: admission.digest,
    expected_revision: 7,
    context_digest: admission.contextDigest,
    adopt_stage: admission.adoptStage
  })
})

it.each([404, 503, 200])(
  'keeps old or unverifiable servers closed without a mutation (%s)',
  async (status) => {
    reply({ ok: status === 200 }, status)
    expect(await admitRetainedFleetTask(admission, isCurrent, true)).toMatchObject({ ok: false })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1]!.method).toBe('GET')
  }
)

it('refuses canonical proof for another task revision even if the projected jobs match', async () => {
  reply({
    ok: true,
    contract: 'conversation-admission-reconciliation.v1',
    task_id: taskId,
    canonical_command_replay: true
  })
  reply({
    ok: true,
    workflow_id: graph.dispatch_id,
    jobs: [admittedJob],
    receipt: {},
    reconciliation: { ...reconciliationProof(), expected_revision: 8 }
  })
  expect(await admitRetainedFleetTask(admission, isCurrent, true)).toMatchObject({
    ok: false,
    error: { code: 'invalid_response' }
  })
})
