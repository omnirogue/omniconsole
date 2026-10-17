// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkflowComposer } from './WorkflowComposer'
import { workflowPreviewFixture } from './console-workflow-test-fixtures'

vi.mock('@/hooks/useWorkAgentCapabilities', () => ({
  useWorkAgentCapabilities: () => ({
    usable: [],
    capabilities: [],
    loading: false,
    refresh: vi.fn(async () => [])
  })
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, value: string) => value }))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: { activeWorktreeId: null }) => unknown) =>
    selector({ activeWorktreeId: null })
}))
vi.mock('@/components/build-review/use-build-review-agent-models', () => ({
  useBuildReviewAgentModels: () => []
}))

const api = { inventory: vi.fn(), getTask: vi.fn(), previewTask: vi.fn(), admitTask: vi.fn() }
const start = vi.fn()
beforeEach(() => {
  vi.resetAllMocks()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { consoleWorkflows: api, consoleLocalExecution: { start } }
  })
  api.inventory.mockResolvedValue({
    ok: false,
    error: { code: 'capability_unavailable', message: 'No catalog route' }
  })
  api.getTask.mockResolvedValue({ ok: true, data: { id: 'btk_test1234', state_revision: 7 } })
  api.admitTask.mockResolvedValue({
    ok: true,
    data: { workflow_id: 'wf_test', jobs: [], receipt: {} }
  })
})
afterEach(cleanup)

it('collects explicit authority and argv, shows the reviewed adoption and admits only on consent', async () => {
  const user = userEvent.setup()
  const onAdmitted = vi.fn()
  const preview = workflowPreviewFixture()
  preview.graph.nodes[0].key = 'stage-1'
  preview.graph.nodes[0].acceptance_commands = [
    { program: 'node', args: ['test.js', ' spaced value ', ''], timeout_ms: 1000 }
  ]
  preview.graph.columns = [['stage-1']]
  api.previewTask.mockResolvedValue({ ok: true, data: preview })
  render(<WorkflowComposer initialTaskId="btk_test1234" onAdmitted={onAdmitted} />)
  const fill = (label: string, value: string) =>
    fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { value } })
  fill('Company slug', 'example')
  fill('Repository (owner/name)', 'Example/project')
  fill('Workflow title', 'Build search')
  fill('Workflow prompt', 'Implement the requested search')
  fill('Stage title', 'Build search')
  fill('Exact stage prompt', 'Implement search')
  fill('Model', 'test-model')
  fill('Goal ID', 'cgl_existing')
  fill('Organization unit ID', 'ou_dev')
  fill('Current authority epoch', '3')
  fill('Objective title', 'Search objective')
  fill('Desired result', 'Search shipped')
  fill('Acceptance policy (JSON object)', '{"required":["all_selected_nodes_verified"]}')
  fill('Verification policy (JSON object)', '{"schema_version":1}')
  await user.click(screen.getByLabelText('Stage adopting this task'))
  await user.click(screen.getByRole('option', { name: 'Build search' }))
  await user.click(screen.getByText('Inputs, acceptance and placement'))
  await user.click(screen.getByRole('button', { name: 'Add acceptance command' }))
  fill('Program', 'node')
  fill('Arguments (JSON array)', '["test.js"," spaced value ",""]')
  fill('Timeout (ms)', '1000')
  expect(api.admitTask).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: 'Preview workflow' }))
  await screen.findByRole('heading', { name: 'Server preview' })
  expect(api.previewTask).toHaveBeenCalledWith(
    expect.objectContaining({
      taskId: 'btk_test1234',
      expectedRevision: 7,
      classification: expect.objectContaining({
        steps: [
          expect.objectContaining({
            actor_id: 'codex:test-model',
            acceptance_commands: preview.graph.nodes[0].acceptance_commands
          })
        ]
      })
    })
  )
  expect(screen.getByText('Observed task revision')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Approve workflow' })).toBeDisabled()
  await user.click(screen.getByRole('checkbox'))
  await user.click(screen.getByRole('button', { name: 'Approve workflow' }))
  await waitFor(() => expect(onAdmitted).toHaveBeenCalledWith('wf_test'))
  expect(api.admitTask).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      graph: preview.graph,
      digest: preview.digest,
      taskId: 'btk_test1234',
      adoptStage: 'stage-1',
      expectedRevision: 7,
      expectedAuthorityEpoch: 3,
      orgUnitId: 'ou_dev'
    })
  )
  expect(start).not.toHaveBeenCalled()
})
