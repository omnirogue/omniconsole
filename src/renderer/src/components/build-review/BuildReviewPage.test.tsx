// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BuildReviewPage from './BuildReviewPage'
import { pipelineFixture } from './build-review-test-fixture'

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  refreshAll: vi.fn(),
  reply: vi.fn(),
  cancel: vi.fn(),
  open: vi.fn(),
  openBuild: vi.fn(),
  focus: vi.fn(),
  rpc: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector({ buildReview: mocks.state })
}))
vi.mock('@/i18n/i18n', () => ({
  // AgentIcon's catalog reads the active language when it loads.
  i18n: { language: 'en' },
  translate: (_key: string, english: string, args?: Record<string, unknown>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(args?.[key] ?? ''))
}))
vi.mock('@/components/AgentStateDot', () => ({
  AgentStateDot: ({ state }: { state: string }) => (
    <span data-testid="state-dot" data-state={state} />
  )
}))
vi.mock('@/components/sidebar/CommentMarkdown', () => ({
  default: ({ content, variant }: { content: string; variant?: string }) => (
    <div data-markdown={variant}>{content}</div>
  )
}))
vi.mock('../local-run/LocalRunLivePane', () => ({
  LocalRunLivePane: ({ handle }: { handle: string | null }) => (
    <div data-testid="live-pane" data-handle={handle} />
  )
}))
vi.mock('../local-workflows/workflow-presets', () => ({
  WorkflowPresetIcon: ({ preset }: { preset: string }) => (
    <span data-testid="preset-icon" data-preset={preset} />
  )
}))
vi.mock('@/components/task-page/relative-time', () => ({ formatRelativeTime: () => 'just now' }))
vi.mock('@/components/terminal-pane/terminal-handle-links', () => ({
  focusRendererTerminalHandle: mocks.focus
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/lib/build-review-entry', () => ({ openBuildReview: mocks.openBuild }))
beforeEach(() => {
  vi.clearAllMocks()
  const pipeline = pipelineFixture()
  mocks.state = {
    pipelinesById: { [pipeline.id]: pipeline },
    selectedPipelineId: pipeline.id,
    refreshAll: mocks.refreshAll,
    reply: mocks.reply,
    cancel: mocks.cancel,
    openStartDialog: mocks.open,
    select: vi.fn(),
    error: null
  }
  mocks.reply.mockResolvedValue(undefined)
  mocks.cancel.mockResolvedValue(undefined)
  mocks.rpc.mockResolvedValue(undefined)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
describe('BuildReviewPage', () => {
  it('renders both workers, reports, events and a replyable question', async () => {
    render(<BuildReviewPage />)
    expect(screen.getByText('Builder')).toBeInTheDocument()
    expect(screen.getByText('Reviewer')).toBeInTheDocument()
    expect(screen.getByText('Search implemented')).toBeInTheDocument()
    expect(screen.getByText('src/search.tsx')).toBeInTheDocument()
    // The running reviewer lends its own terminal inline; the finished builder does not.
    expect(screen.getByTestId('live-pane')).toHaveAttribute('data-handle', 'term_reviewer')
    // The event log is folded into Activity until someone opens it.
    expect(screen.queryByRole('log')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Activity/ }))
    expect(screen.getByRole('log')).toHaveTextContent('Review started')
    expect(screen.getByText('Should search include archived items?')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Reply'), { target: { value: ' Yes ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
    await waitFor(() => expect(mocks.reply).toHaveBeenCalledWith('pipeline-1', 'message-1', 'Yes'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith('pipeline-1'))
  })
  it('shows every reviewer verdict and keeps previous round reports available', () => {
    const pipeline = pipelineFixture({ pendingQuestion: null, round: 2, maxReviewRounds: 3 })
    const report = { ...pipeline.builder.report!, filesModified: [] }
    pipeline.reviewers = [
      {
        ...pipeline.reviewer,
        status: 'succeeded',
        report: {
          ...report,
          subject: 'Keyboard issue',
          body: 'Keyboard broken\nVERDICT: REQUEST_CHANGES'
        }
      },
      {
        ...pipeline.reviewer,
        choice: { agent: 'codex' },
        status: 'succeeded',
        report: { ...report, subject: 'Checked search', body: 'VERDICT: APPROVE' }
      }
    ]
    pipeline.rounds = [{ number: 1, builder: pipeline.builder, reviewers: [pipeline.reviewer] }]
    mocks.state.pipelinesById = { [pipeline.id]: pipeline }
    render(<BuildReviewPage />)
    expect(screen.getByText('Round 2 of 3')).toBeInTheDocument()
    const first = screen.getByRole('region', { name: 'Reviewer 1' })
    expect(within(first).getByText('Changes requested')).toBeInTheDocument()
    expect(within(first).getByText('Keyboard issue')).toBeInTheDocument()
    expect(
      within(screen.getByRole('region', { name: 'Reviewer 2' })).getByText('Approved')
    ).toBeInTheDocument()
    // Earlier rounds stay available, folded under their round number.
    fireEvent.click(screen.getByRole('button', { name: /^Round 1/ }))
    expect(document.querySelector('[data-build-review-round="1"]')).toHaveTextContent(
      'Search implemented'
    )
  })

  it('starts a new run through the one Build + Review entry, which asks for a workspace', () => {
    render(<BuildReviewPage />)
    fireEvent.click(screen.getByRole('button', { name: 'New Build + Review' }))
    expect(mocks.openBuild).toHaveBeenCalledWith()
    expect(mocks.open).not.toHaveBeenCalled()
  })

  it('shows the wrench in the empty state', () => {
    mocks.state.pipelinesById = {}
    render(<BuildReviewPage />)
    expect(screen.getByText('No build and review pipelines yet')).toBeInTheDocument()
    expect(
      screen.getAllByTestId('preset-icon').every((icon) => icon.dataset.preset === 'build-review')
    ).toBe(true)
    expect(screen.getAllByTestId('preset-icon').length).toBeGreaterThanOrEqual(2)
  })

  it('focuses by runtime handle when no renderer terminal is mounted', async () => {
    mocks.focus.mockReturnValue(false)
    render(<BuildReviewPage />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Open terminal' })[0])
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith({ kind: 'local' }, 'terminal.focus', {
        terminal: 'term_builder',
        navigation: 'host'
      })
    )
  })
  it('refreshes on open and polls only as a slow fallback while active, cleaning up on close', () => {
    vi.useFakeTimers()
    const view = render(<BuildReviewPage />)
    expect(mocks.refreshAll).toHaveBeenCalledTimes(1)
    // Changes are pushed; the poll only catches a missed push.
    act(() => vi.advanceTimersByTime(3000))
    expect(mocks.refreshAll).toHaveBeenCalledTimes(1)
    act(() => vi.advanceTimersByTime(7000))
    expect(mocks.refreshAll).toHaveBeenCalledTimes(2)
    view.unmount()
    act(() => vi.advanceTimersByTime(10_000))
    expect(mocks.refreshAll).toHaveBeenCalledTimes(2)
    const pipeline = pipelineFixture({ stage: 'completed', pendingQuestion: null })
    mocks.state.pipelinesById = { [pipeline.id]: pipeline }
    render(<BuildReviewPage />)
    act(() => vi.advanceTimersByTime(10_000))
    expect(mocks.refreshAll).toHaveBeenCalledTimes(3)
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
  })
})
