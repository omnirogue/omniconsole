// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BuildReviewWorkerSnapshot } from '../../../../shared/build-review-pipeline'
import { BuildReviewDetail } from './BuildReviewDetail'
import { pipelineFixture } from './build-review-test-fixture'

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  reply: vi.fn(),
  refreshOne: vi.fn(),
  rpc: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      buildReview: { cancel: mocks.cancel, reply: mocks.reply, refreshOne: mocks.refreshOne },
      agentStatusByPaneKey: {}
    })
}))
vi.mock('@/i18n/i18n', () => ({
  // AgentIcon's catalog reads the active language when it loads.
  i18n: { language: 'en' },
  translate: (_key: string, english: string, args?: Record<string, unknown>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(args?.[key] ?? ''))
}))
vi.mock('@/hooks/use-now', () => ({ useNow: () => 0 }))
vi.mock('@/components/AgentStateDot', () => ({
  AgentStateDot: ({ state }: { state: string }) => (
    <span data-testid="state-dot" data-state={state} />
  )
}))
vi.mock('@/components/sidebar/CommentMarkdown', () => ({
  default: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div>
}))
vi.mock('../local-run/LocalRunLivePane', () => ({
  LocalRunLivePane: ({ handle }: { handle: string | null }) => (
    <div data-testid="live-pane" data-handle={handle} />
  )
}))
vi.mock('@/components/terminal-pane/terminal-handle-links', () => ({
  focusRendererTerminalHandle: vi.fn(() => true)
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))

function reviewer(
  status: BuildReviewWorkerSnapshot['status'],
  body?: string
): BuildReviewWorkerSnapshot {
  return {
    role: 'reviewer',
    choice: { agent: 'claude', model: 'opus', effort: 'high' },
    status,
    taskId: null,
    dispatchId: null,
    terminalHandle: status === 'pending' ? null : 'term_reviewer',
    error: null,
    report: body
      ? {
          subject: 'Review done',
          body,
          outcome: 'succeeded',
          filesModified: [],
          reportPath: null,
          reportedAt: '2026-09-21T12:00:00Z'
        }
      : null
  }
}

function stepState(id: string): string | null {
  return (
    document.querySelector(`[data-build-review-step="${id}"]`)?.getAttribute('data-state') ?? null
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.cancel.mockResolvedValue(undefined)
  mocks.refreshOne.mockResolvedValue(null)
  mocks.rpc.mockResolvedValue({})
})
afterEach(cleanup)

describe('BuildReviewDetail', () => {
  it('shows the fix step, the round and reviewers that have not started as waiting rows', () => {
    const pipeline = pipelineFixture({
      stage: 'building',
      round: 2,
      maxReviewRounds: 3,
      pendingQuestion: null,
      builder: { ...pipelineFixture().builder, status: 'running', report: null },
      reviewers: [reviewer('pending'), reviewer('pending'), reviewer('pending')]
    })
    render(<BuildReviewDetail pipeline={pipeline} liveTerminal />)
    expect(stepState('build')).toBe('done')
    expect(stepState('review')).toBe('done')
    expect(stepState('fix')).toBe('active')
    expect(document.querySelector('[data-build-review-step="fix"]')).toHaveAttribute(
      'aria-current',
      'step'
    )
    expect(screen.getByText('Round 2 of 3')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Builder · fixing findings' })).toBeInTheDocument()
    expect(screen.getByTestId('live-pane')).toHaveAttribute('data-handle', 'term_builder')
    const waiting = document.querySelectorAll('[data-build-review-waiting]')
    expect([...waiting].map((row) => row.textContent)).toEqual([
      expect.stringContaining('Reviewer 1'),
      expect.stringContaining('Reviewer 2'),
      expect.stringContaining('Reviewer 3')
    ])
    expect([...waiting].every((row) => row.textContent?.includes('Waiting'))).toBe(true)
    expect(screen.queryByRole('region', { name: /Reviewer/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('lends the running terminal only when the surface can show it', () => {
    const pipeline = pipelineFixture({ stage: 'reviewing', pendingQuestion: null })
    render(<BuildReviewDetail pipeline={pipeline} />)
    // A conversation tab: the running reviewer still shows its live state and a way into its
    // terminal, but no inline slot that would stay empty.
    expect(screen.getByRole('region', { name: 'Reviewer' })).toBeInTheDocument()
    expect(screen.queryByTestId('live-pane')).toBeNull()
    expect(
      within(screen.getByRole('region', { name: 'Reviewer' })).getByRole('button', {
        name: 'Show live terminal'
      })
    ).toBeEnabled()
    expect(
      within(screen.getByRole('region', { name: 'Builder' })).getByRole('button', {
        name: 'Open terminal'
      })
    ).toBeEnabled()
  })

  it('draws an earlier round as a plain disclosure, so its worker cards are the only frames', () => {
    const base = pipelineFixture({ stage: 'building', pendingQuestion: null })
    const pipeline = pipelineFixture({
      stage: 'building',
      round: 2,
      maxReviewRounds: 3,
      pendingQuestion: null,
      rounds: [{ number: 1, builder: base.builder, reviewers: [reviewer('succeeded', 'Fine')] }]
    })
    render(<BuildReviewDetail pipeline={pipeline} />)
    const round = document.querySelector('[data-build-review-round="1"]')!
    expect(round).not.toHaveClass('border')
    fireEvent.click(screen.getByRole('button', { name: /^Round 1/ }))
    expect(round.querySelectorAll('[data-build-review-worker]')).toHaveLength(2)
    expect(round.querySelector('.border-t')).toBeNull()
  })

  it('says reviewers of a stopped run did not run instead of waiting', () => {
    const pipeline = pipelineFixture({
      stage: 'failed',
      round: 1,
      pendingQuestion: null,
      error: 'The builder reported failure; review skipped.',
      builder: { ...pipelineFixture().builder, status: 'failed' },
      reviewers: [reviewer('pending'), reviewer('pending')]
    })
    render(<BuildReviewDetail pipeline={pipeline} />)
    const rows = [...document.querySelectorAll('[data-build-review-waiting]')]
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.getAttribute('data-build-review-waiting') === 'not-run')).toBe(
      true
    )
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Did not run'),
      expect.stringContaining('Did not run')
    ])
    expect(screen.queryByText('Waiting')).toBeNull()
    expect(stepState('build')).toBe('failed')
  })

  it('folds the event log into Activity without heartbeats or internal ids', () => {
    const pipeline = pipelineFixture({
      pendingQuestion: null,
      events: [
        {
          at: '2026-09-21T12:00:00Z',
          kind: 'info',
          role: 'pipeline',
          text: 'Pipeline created for id:repo::/w'
        },
        { at: '2026-09-21T12:00:01Z', kind: 'heartbeat', role: 'builder', text: 'alive' },
        {
          at: '2026-09-21T12:00:02Z',
          kind: 'info',
          role: 'reviewer',
          text: 'Dispatch ctx_7 is running'
        }
      ]
    })
    render(<BuildReviewDetail pipeline={pipeline} />)
    expect(screen.queryByRole('log')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Activity/ }))
    const log = screen.getByRole('log')
    expect(log).toHaveTextContent('Run created')
    expect(log).toHaveTextContent('Agent is running')
    expect(log).not.toHaveTextContent('alive')
    expect(log).not.toHaveTextContent('ctx_7')
    expect(log).not.toHaveTextContent('id:repo')
  })

  it('shows an approved run with the fix step not needed and nothing live', () => {
    const pipeline = pipelineFixture({
      stage: 'completed',
      round: 1,
      maxReviewRounds: 3,
      pendingQuestion: null,
      hubTaskId: 'btk_12345678',
      reviewers: [reviewer('succeeded', 'All good.\n\n> **VERDICT: APPROVE**')]
    })
    render(<BuildReviewDetail pipeline={pipeline} />)
    expect(stepState('fix')).toBe('skipped')
    expect(screen.getAllByText('Approved')).toHaveLength(2)
    // Hub board cards were retired, so the bound card is named, not linked.
    expect(screen.getByText('Linked task btk_12345678')).toBeInTheDocument()
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.queryByText(/omnios card/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
    expect(screen.queryByTestId('live-pane')).toBeNull()
    expect(screen.queryByTestId('state-dot')).toBeNull()
  })

  it('shows a run that ended at its round limit with changes requested as that outcome, not failed', () => {
    const pipeline = pipelineFixture({
      stage: 'failed',
      round: 3,
      maxReviewRounds: 3,
      pendingQuestion: null,
      error: 'Review limit reached after 3 round(s); unresolved findings remain.',
      reviewers: [
        reviewer('succeeded', 'VERDICT: APPROVE'),
        reviewer('succeeded', 'MAJOR: src/a.ts:1 broken\nVERDICT: REQUEST_CHANGES.')
      ]
    })
    render(<BuildReviewDetail pipeline={pipeline} />)
    expect(stepState('review')).toBe('done')
    // The fix was needed; no round was left for it.
    expect(stepState('fix')).toBe('round-limit')
    const fix = document.querySelector('[data-build-review-step="fix"]')
    expect(fix).toHaveTextContent('Round limit reached')
    expect(fix).not.toHaveTextContent('Not needed')
    expect(screen.queryByRole('alert')).toBeNull()
    const outcome = screen.getByRole('region', { name: 'Changes requested — round limit reached' })
    expect(within(outcome).getByRole('status')).toHaveTextContent(
      'Changes requested — round limit reached'
    )
    // The raw line stays reachable, folded under Details.
    expect(outcome.querySelector('[data-build-review-details]')).toHaveTextContent(
      'Review limit reached'
    )
    expect(screen.getAllByText('Changes requested')).toHaveLength(2)
    expect(document.querySelector('[data-build-review-severity="major"]')).toHaveTextContent(
      'Major1'
    )
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled()
  })

  it('still files a run that failed before its last round as failed', () => {
    const pipeline = pipelineFixture({
      stage: 'failed',
      round: 1,
      maxReviewRounds: 3,
      pendingQuestion: null,
      error: 'Reviewer 1 could not complete the review; approval is not established.',
      reviewers: [reviewer('succeeded', 'VERDICT: REQUEST_CHANGES')]
    })
    render(<BuildReviewDetail pipeline={pipeline} />)
    expect(screen.queryByRole('region', { name: /round limit reached/ })).toBeNull()
    expect(screen.getByRole('alert')).toHaveTextContent('could not complete the review')
  })

  it("counts a reviewer's findings stated in prose and opens its full report", async () => {
    const summary =
      'The fix is correct, but I found one unresolved MAJOR at src/reserve.ts:16 (unawaited save). Also two NITs; full findings are in the report path.\n\nVERDICT: REQUEST_CHANGES'
    const withReport = reviewer('succeeded', summary)
    withReport.report = {
      ...withReport.report!,
      subject: 'Review: 1 MAJOR (unawaited save) -> REQUEST_CHANGES',
      reportPath: '/tmp/scratchpad/REVIEW.md'
    }
    render(
      <BuildReviewDetail
        pipeline={pipelineFixture({
          stage: 'reviewing',
          pendingQuestion: null,
          reviewers: [withReport]
        })}
      />
    )
    const reviewerCard = screen.getByRole('region', { name: 'Reviewer' })
    expect(reviewerCard.querySelector('[data-build-review-severity="major"]')).toHaveTextContent(
      'Major1'
    )
    expect(reviewerCard.querySelector('[data-build-review-severity="nit"]')).toHaveTextContent(
      'Nit2'
    )
    expect(within(reviewerCard).getByRole('button', { name: 'Open full report' })).toBeEnabled()
  })
  it('says in words which worker could not start and retries the same run', async () => {
    const pipeline = pipelineFixture({
      stage: 'failed',
      pendingQuestion: null,
      error: 'builder: agent_prompt_stalled',
      builder: {
        ...pipelineFixture().builder,
        choice: { agent: 'claude' },
        status: 'failed',
        report: null,
        error: 'agent_prompt_stalled',
        startupBlocker: 'claude-folder-trust'
      },
      reviewers: [reviewer('pending')]
    })
    render(<BuildReviewDetail pipeline={pipeline} />)
    const alerts = screen.getAllByRole('alert')
    expect(alerts[0]).toHaveTextContent(
      'The builder could not start. Claude is asking whether to trust this folder — open the terminal to answer.'
    )
    expect(alerts.some((alert) => alert.textContent?.includes('agent_prompt_stalled'))).toBe(false)
    expect(
      within(screen.getByRole('region', { name: 'Builder' })).getByRole('button', {
        name: 'Open terminal'
      })
    ).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(mocks.refreshOne).toHaveBeenCalledWith('pipeline-1'))
    expect(mocks.rpc).toHaveBeenCalledWith({ kind: 'local' }, 'buildReview.retry', {
      id: 'pipeline-1'
    })
  })

  it('says in plain words why Retry is refused while another run works in the workspace', async () => {
    const busy =
      'A Build + Review run is already working in this workspace. Stop it or wait for it to finish.'
    mocks.rpc.mockRejectedValueOnce(
      new Error('Pipeline brp_0123456789ab is still reviewing in this workspace.')
    )
    const stopped = { pendingQuestion: null, reviewers: [reviewer('pending')] }
    const { rerender } = render(
      <BuildReviewDetail pipeline={pipelineFixture({ ...stopped, stage: 'cancelled' })} />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText(busy)).toBeInTheDocument()
    expect(screen.queryByText(/Pipeline/)).toBeNull()
    // Started again later (the other run finished): that refusal no longer applies.
    rerender(
      <BuildReviewDetail
        pipeline={pipelineFixture({ ...stopped, stage: 'starting', runId: 'run-2' })}
      />
    )
    expect(screen.queryByText(busy)).toBeNull()
  })

  it('names what still holds the workspace and releases it on request', async () => {
    const pipeline = pipelineFixture({
      stage: 'failed',
      pendingQuestion: null,
      error:
        'Build + Review pipeline brp_0123456789ab still owns this workspace (Run run_0123456789ab); inspect unresolved Dispatch ctx_0123456789ab.',
      builder: { ...pipelineFixture().builder, status: 'pending', report: null },
      reviewers: [reviewer('pending')],
      workspaceHold: {
        pipelineId: 'brp_0123456789ab',
        runId: 'run_0123456789ab',
        items: [
          {
            kind: 'terminal-open',
            role: 'builder',
            dispatchId: 'ctx_0123456789ab',
            terminalHandle: 'term_old_builder',
            releasable: true
          }
        ]
      }
    })
    render(<BuildReviewDetail pipeline={pipeline} />)
    expect(screen.getByRole('alert')).toHaveTextContent(
      'An earlier Build + Review run still holds this workspace.'
    )
    expect(screen.getByRole('alert')).not.toHaveTextContent('brp_0123456789ab')
    const hold = screen.getByRole('region', { name: 'Workspace still reserved' })
    expect(hold).toHaveTextContent("The builder's terminal is still open.")
    expect(within(hold).getByRole('button', { name: 'Open terminal' })).toBeEnabled()
    fireEvent.click(within(hold).getByRole('button', { name: 'Release workspace' }))
    await waitFor(() => expect(mocks.refreshOne).toHaveBeenCalledWith('pipeline-1'))
    expect(mocks.rpc).toHaveBeenCalledWith({ kind: 'local' }, 'buildReview.releaseWorkspace', {
      id: 'pipeline-1'
    })
  })

  it('offers no Retry or release while the run is still going', () => {
    render(<BuildReviewDetail pipeline={pipelineFixture({ pendingQuestion: null })} />)
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Workspace still reserved' })).toBeNull()
  })
})
