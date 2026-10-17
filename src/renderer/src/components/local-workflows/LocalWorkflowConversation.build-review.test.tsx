// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { LocalWorkflowConversation } from './LocalWorkflowConversation'

const mocks = vi.hoisted(() => {
  const agent = (id: string, models: string[]) => ({
    id,
    label: id,
    models: models.map((model) => ({ id: model, label: model, options: [], isDefault: true })),
    modelsProbed: true
  })
  return {
    update: vi.fn(),
    title: vi.fn(),
    start: vi.fn(),
    select: vi.fn(),
    openPage: vi.fn(),
    refreshOne: vi.fn(),
    pipelinesById: {} as Record<string, unknown>,
    agents: [agent('codex', ['gpt-5.5']), agent('claude', ['opus'])]
  }
})

const state = {
  folderWorkspaces: [],
  unifiedTabsByWorktree: {} as Record<string, unknown>,
  buildReview: {
    pipelinesById: mocks.pipelinesById,
    start: mocks.start,
    select: mocks.select,
    refreshOne: mocks.refreshOne
  },
  openBuildReviewPage: mocks.openPage
}

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
    getState: () => state
  })
}))
vi.mock('@/store/selectors', () => ({
  useAllWorktrees: () => [{ id: 'repo::/workspace', path: '/workspace', branch: 'feature' }]
}))
vi.mock('@/hooks/useWorkAgentCapabilities', () => ({
  useWorkAgentCapabilities: () => ({ usable: mocks.agents, loading: false })
}))
vi.mock('../build-review/use-build-review-agent-models', () => ({
  useBuildReviewAgentModels: () => []
}))
vi.mock('./use-local-workflow-controller', () => ({ useLocalWorkflowController: () => undefined }))
vi.mock('@/lib/local-workflow-conversation', () => ({
  updateLocalWorkflowConversation: mocks.update,
  titleLocalWorkflowConversation: mocks.title
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, english: string) => english }))
vi.mock('@/lib/agent-catalog', () => ({ AgentIcon: () => null }))

const tab = (pipelineId?: string): TerminalTab =>
  ({
    id: 'workflow-tab',
    worktreeId: 'repo::/workspace',
    localWorkflow: {
      preset: 'build-review',
      prompt: 'Saved objective',
      buildReviewPipelineId: pipelineId
    }
  }) as TerminalTab

beforeEach(() => {
  vi.clearAllMocks()
  state.buildReview.pipelinesById = {}
  mocks.start.mockResolvedValue({ id: 'pipeline-1' })
  mocks.refreshOne.mockResolvedValue(null)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('Build + Review workflow conversation', () => {
  // The form's own fields belong to Build + Review; this only pins how the tab hosts it.
  it('starts the Build + Review pipeline in place and names the tab after the objective', async () => {
    render(<LocalWorkflowConversation tab={tab()} />)
    expect(screen.getByRole('region', { name: 'Build + Review' })).toBeInTheDocument()
    expect(screen.getByLabelText('Objective')).toHaveValue('Saved objective')
    expect(screen.queryByRole('button', { name: 'Chat' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Start Build + Review' }))
    await waitFor(() => expect(mocks.start).toHaveBeenCalledOnce())
    expect(mocks.start).toHaveBeenCalledWith(
      expect.objectContaining({
        worktree: 'id:repo::/workspace',
        objective: 'Saved objective',
        builder: expect.objectContaining({ agent: 'codex' }),
        reviewers: [expect.objectContaining({ agent: 'claude' })]
      }),
      { reveal: false }
    )
    expect(mocks.update).toHaveBeenCalledWith(
      'repo::/workspace',
      'workflow-tab',
      expect.objectContaining({ buildReviewPipelineId: 'pipeline-1' })
    )
    expect(mocks.title).toHaveBeenCalledWith('workflow-tab', 'Saved objective')
    expect(mocks.openPage).not.toHaveBeenCalled()
  })

  it('reads a running pipeline once and then relies on the pushed changes', async () => {
    state.buildReview.pipelinesById = {}
    render(<LocalWorkflowConversation tab={tab('pipeline-2')} />)
    await waitFor(() => expect(mocks.refreshOne).toHaveBeenCalledWith('pipeline-2'))
    vi.useFakeTimers()
    vi.advanceTimersByTime(10_000)
    expect(mocks.refreshOne).toHaveBeenCalledTimes(1)
  })

  it('says a run the host no longer has is gone, keeping its raw line under Details', async () => {
    mocks.refreshOne.mockResolvedValue(
      'RuntimeRpcCallError: Build + Review pipeline brp_017a7995fae7 was not found.'
    )
    render(<LocalWorkflowConversation tab={tab('pipeline-1')} />)
    // Why the text, not the first status: "Loading…" is a status too until the read fails.
    const gone = await screen.findByText('This run is no longer available.')
    const notice = gone.closest('[role="status"]') as HTMLElement
    expect(notice).not.toBeNull()
    expect(gone).not.toHaveTextContent('RuntimeRpcCallError')
    expect(notice.querySelector('[data-build-review-details]')).toHaveTextContent(
      'brp_017a7995fae7 was not found'
    )
    // Nothing to retry: the host will never have this run again.
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(screen.queryByLabelText('View')).toBeNull()
    vi.useFakeTimers()
    vi.advanceTimersByTime(2500)
    expect(mocks.refreshOne).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'View all Build + Review runs' }))
    expect(mocks.select).toHaveBeenCalledWith('pipeline-1')
    expect(mocks.openPage).toHaveBeenCalledOnce()
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('words any other read failure plainly and offers a Retry', async () => {
    mocks.refreshOne.mockResolvedValueOnce('RuntimeRpcCallError: runtime_unavailable')
    render(<LocalWorkflowConversation tab={tab('pipeline-1')} />)
    const alert = await screen.findByRole('alert')
    expect(alert.querySelector('p')).toHaveTextContent('runtime_unavailable')
    expect(alert.querySelector('p')).not.toHaveTextContent('RuntimeRpcCallError')
    expect(alert).toHaveTextContent('Check active workers or terminals')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(mocks.refreshOne).toHaveBeenCalledTimes(2))
  })
})
