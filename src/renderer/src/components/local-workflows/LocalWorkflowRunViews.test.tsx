// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalWorkflowExecutionView } from './LocalWorkflowExecutionView'
import {
  completedCouncilRunView,
  councilRunView,
  discoverRunView,
  workflowCall
} from './local-workflow-run.fixtures'
import type { LocalWorkflowView } from '../../../../shared/local-workflow-view'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, values?: Record<string, string | number>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(values?.[key] ?? ''))
}))
vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: ({ agent }: { agent: string }) => <span data-agent-icon={agent} />
}))
afterEach(cleanup)

function selectTab(name: RegExp, index = 0) {
  fireEvent.mouseDown(screen.getAllByRole('tab', { name })[index], { button: 0 })
}

describe('Council run view', () => {
  it('streams what a member is writing and shows finished answers as documents', () => {
    render(<LocalWorkflowExecutionView view={councilRunView()} />)
    expect(screen.getByLabelText('Your request')).toHaveTextContent('Check the selected scope')
    const rail = screen.getByRole('list', { name: 'Council stages' })
    expect(within(rail).getByText('First opinions')).toBeVisible()
    expect(within(rail).getByText('Collecting individual responses…')).toBeVisible()
    expect(within(rail).getByText("Chairman's answer")).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Use an idempotency key' })).toBeVisible()
    expect(screen.getAllByText('1:12')[0]).toBeVisible()
    expect(screen.getAllByText('3.4k tokens')[0]).toBeVisible()
    selectTab(/Grok 4\.6/)
    expect(screen.getByText('Reading src/checkout/pay.ts')).toBeVisible()
    expect(
      screen.getByText('The retry path re-enters charge() without the original key, so')
    ).toBeVisible()
  })

  it('shows a failed member inline and keeps the other answers', () => {
    const view = councilRunView()
    view.calls = view.calls.map((call) =>
      call.id === 'answer/seat-3'
        ? { ...call, state: 'failed', live: undefined, error: 'timed out after 15:00' }
        : call
    )
    render(<LocalWorkflowExecutionView view={view} />)
    selectTab(/Grok 4\.6/)
    expect(screen.getByText("Grok 4.6 didn't finish: timed out after 15:00")).toBeVisible()
    selectTab(/GPT-5\.6 Sol/)
    expect(screen.getByText('Persist the result first.')).toBeVisible()
  })

  it('de-anonymises each ballot, lists the extracted ranking and the street cred', () => {
    render(<LocalWorkflowExecutionView view={councilRunView()} />)
    expect(
      screen.getByText(
        'Each model ranked every answer without knowing who wrote it. Model names are shown here for readability.'
      )
    ).toBeVisible()
    const rankings = screen.getByRole('tablist', { name: 'Rankings by model' })
    expect(within(rankings).queryByRole('tab', { name: /Gemini/ })).toBeNull()
    expect(screen.getByText('Gemini 3.8 Flash: answers only, never ranks.')).toBeVisible()
    expect(screen.queryByText(/Response B is precise/)).toBeNull()
    expect(screen.getAllByText('GPT-5.6 Sol', { selector: 'strong' })[0]).toBeVisible()
    expect(screen.getByText('Extracted ranking')).toBeVisible()
    const table = screen.getByRole('region', { name: 'Street cred' })
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('#1GPT-5.6 Sol1.001')
    expect(
      within(table).getByText("A model's vote for its own answer is not counted.")
    ).toBeVisible()
  })

  it('shows an answer no counted vote ranked as unranked, last, never as 0.00', () => {
    const view = councilRunView()
    // Claude's only vote was for its own answer, which the aggregate drops.
    view.councilRun!.standings = [
      { label: 'Response A', seatId: 'seat-1', averageRank: 0, votes: 0, place: 1 },
      { label: 'Response B', seatId: 'seat-2', averageRank: 1, votes: 1, place: 1 }
    ]
    render(<LocalWorkflowExecutionView view={view} />)
    const rows = within(screen.getByRole('region', { name: 'Street cred' })).getAllByRole('row')
    expect(rows[1]).toHaveTextContent('#1GPT-5.6 Sol1.001')
    expect(rows[2]).toHaveTextContent('Claude Opus 5')
    expect(rows[2]).toHaveTextContent('Not ranked')
    expect(rows[2]).not.toHaveTextContent('0.00')
    expect(rows[2]).not.toHaveTextContent('#')
  })

  it('says how older councils ranked: each reviewer saw only the other answers', () => {
    const view = { ...councilRunView(), revision: 5 }
    render(<LocalWorkflowExecutionView view={view} />)
    expect(
      screen.getByText(
        'Each reviewer ranked the other answers anonymously. Model names are shown here for readability.'
      )
    ).toBeVisible()
    expect(screen.queryByText(/ranked every answer/)).toBeNull()
    // No reviewer saw its own answer, so there was no self-vote to drop.
    expect(screen.queryByText("A model's vote for its own answer is not counted.")).toBeNull()
  })

  it('says when a ballot could not be read instead of inventing a ranking', () => {
    const view = councilRunView()
    view.councilRun!.ballots[0].ranking = []
    render(<LocalWorkflowExecutionView view={view} />)
    expect(
      screen.getByText('No ranking could be read from this reply, so it does not count.')
    ).toBeVisible()
  })

  it("leads a finished council with the chairman's answer and its actions", async () => {
    const onNewTurn = vi.fn().mockResolvedValue(undefined)
    const onFollowUp = vi.fn().mockResolvedValue(undefined)
    render(
      <LocalWorkflowExecutionView
        view={{ ...completedCouncilRunView(), followUpSeat: undefined }}
        onNewTurn={onNewTurn}
        onFollowUp={onFollowUp}
      />
    )
    const chair = screen.getByRole('region', { name: "Chairman's answer" })
    expect(within(chair).getByText('Chairman · Claude Opus 5')).toBeVisible()
    expect(within(chair).getByRole('heading', { name: 'Verdict' })).toBeVisible()
    expect(chair).toHaveClass('border-status-success-border')
    // Earlier stages fold away once the answer lands; they reopen from their header.
    expect(screen.queryByRole('heading', { name: 'Use an idempotency key' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /First opinions/ }))
    expect(screen.getByRole('heading', { name: 'Use an idempotency key' })).toBeVisible()
    fireEvent.click(within(chair).getByRole('button', { name: 'Ask a follow-up' }))
    fireEvent.change(screen.getByLabelText('Follow up with Claude Opus 5'), {
      target: { value: 'Why not a lock?' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send follow-up' }))
    await waitFor(() => expect(onFollowUp).toHaveBeenCalledWith('Why not a lock?', undefined))
    fireEvent.click(within(chair).getByRole('button', { name: 'New question' }))
    await waitFor(() => expect(onNewTurn).toHaveBeenCalledTimes(1))
  })

  it('keeps a half-finished stage open with its ballots after the council is stopped', () => {
    const view = councilRunView()
    const stopped: LocalWorkflowView = {
      ...view,
      state: 'cancelled',
      running: 0,
      actions: [],
      calls: view.calls.map((call) =>
        call.state === 'running' ? { ...call, state: 'cancelled', live: undefined } : call
      )
    }
    render(<LocalWorkflowExecutionView view={stopped} />)
    const rail = screen.getByRole('list', { name: 'Council stages' })
    expect(rail.querySelector('[data-stage-id="rank"]')).toHaveAttribute(
      'data-stage-tone',
      'stopped'
    )
    expect(within(rail).getByText('Stopped before it finished')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Street cred' })).toBeVisible()
    expect(screen.getByText('Extracted ranking')).toBeVisible()
  })

  it('loads a call log only when Details opens', async () => {
    const onReadCall = vi.fn().mockResolvedValue({
      stdout: 'loaded transcript',
      stderr: '',
      outputTruncated: false
    })
    render(<LocalWorkflowExecutionView view={councilRunView()} onReadCall={onReadCall} />)
    expect(onReadCall).not.toHaveBeenCalled()
    fireEvent.click(screen.getAllByRole('button', { name: 'Details' })[0])
    await waitFor(() => expect(onReadCall).toHaveBeenCalledWith('answer/seat-1'))
    expect(await screen.findByText('loaded transcript')).toBeVisible()
  })
})

describe('Discover run view', () => {
  it('leads with the ranked report and hands a fix to Build + Review', () => {
    const onFix = vi.fn()
    const onOpenLocation = vi.fn()
    render(
      <LocalWorkflowExecutionView
        view={discoverRunView()}
        onFixWithBuildReview={onFix}
        onOpenLocation={onOpenLocation}
      />
    )
    const report = screen.getByRole('region', { name: 'Report' })
    expect(within(report).getByText('One defect held up under verification.')).toBeVisible()
    expect(within(report).getByText('Can run in parallel')).toBeVisible()
    expect(within(report).getByText('High')).toBeVisible()
    fireEvent.click(within(report).getByRole('button', { name: 'src/checkout/pay.ts:142' }))
    expect(onOpenLocation).toHaveBeenCalledWith('src/checkout/pay.ts:142')
    fireEvent.click(within(report).getByRole('button', { name: 'Fix with Build + Review' }))
    expect(onFix).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Retry drops the idempotency key', parallelSafe: true })
    )
    // Skipped work lives in the run's Notes, one click away.
    fireEvent.click(screen.getByRole('button', { name: /^Notes/ }))
    expect(screen.getByText('Round 3 skipped: the agent limit was reached.')).toBeVisible()
  })

  it('filters findings, merges repeats and reports failed finders inline', () => {
    render(<LocalWorkflowExecutionView view={discoverRunView()} />)
    const find = screen.getByRole('button', { name: /Find/ })
    expect(find).toHaveTextContent('3 found · round 2 of 3')
    fireEvent.click(find)
    expect(screen.getByText("Grok 4.6 didn't finish: timed out after 20:00")).toBeVisible()
    expect(screen.getByRole('button', { name: 'All 2' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('Repeats merged into earlier findings: 1')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Refuted 1' }))
    expect(screen.getByText('Currency rounding loses a cent')).toBeVisible()
    expect(screen.queryByRole('button', { name: /Retry drops the idempotency key/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Confirmed 1' }))
    const card = screen.getByRole('button', { name: /Retry drops the idempotency key/ })
    expect(card).toHaveTextContent('2 real, 0 refuted, 1 unjudged')
    fireEvent.click(card)
    expect(screen.getByText('A second charge runs when the first times out.')).toBeVisible()
    expect(screen.getByText(/Key is rebuilt\./)).toBeVisible()
  })

  it('lists working finders live with what they read, and each one has its logs', async () => {
    const view = discoverRunView()
    const onReadCall = vi.fn().mockResolvedValue({
      stdout: 'finder transcript',
      stderr: '',
      outputTruncated: false
    })
    const live: LocalWorkflowView = {
      ...view,
      state: 'running',
      finishedAt: undefined,
      result: undefined,
      running: 1,
      queued: 1,
      actions: ['pause', 'stop'],
      stages: [
        { id: 'scout', label: 'Scout', completed: 1, total: 1, failed: 0 },
        { id: 'find', label: 'Find', completed: 0, total: 2, failed: 0 },
        { id: 'verify', label: 'Verify', completed: 0, failed: 0 },
        { id: 'rank', label: 'Rank', completed: 0, failed: 0 }
      ],
      calls: [
        workflowCall('scout/map', 'seat-1'),
        workflowCall('find/r1/0/security', 'seat-3', {
          state: 'running',
          endedAt: undefined,
          tokens: undefined,
          live: {
            phase: 'running',
            startedAt: Date.now() - 30_000,
            activity: 'Reading src/checkout/pay.ts',
            tail: 'The retry path rebuilds the key'
          }
        }),
        workflowCall('find/r1/0/correctness', 'seat-2', {
          state: 'queued',
          startedAt: undefined,
          endedAt: undefined,
          tokens: undefined
        })
      ],
      discoverRun: {
        ...view.discoverRun!,
        round: 1,
        findings: [],
        report: undefined,
        dropped: [],
        counts: { found: 0, duplicates: 0, verifying: 0, confirmed: 0, refuted: 0, unverified: 0 }
      }
    }
    render(<LocalWorkflowExecutionView view={live} onReadCall={onReadCall} />)
    expect(
      screen.getByRole('button', { name: 'Agents: 2 · 1 working · 1 waiting' })
    ).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Reading src/checkout/pay.ts')).toBeVisible()
    expect(screen.queryByText('Waiting to start…')).toBeNull()
    expect(screen.getByRole('button', { name: 'Show all 2' })).toBeVisible()
    expect(screen.getByText('Nothing found yet.')).toBeVisible()
    const finder = screen.getByRole('button', { name: /Grok 4\.6.*Security · Checkout/ })
    fireEvent.click(finder)
    expect(screen.getByText('The retry path rebuilds the key')).toBeVisible()
    const row = finder.closest('li')!
    fireEvent.click(within(row).getByRole('button', { name: 'Details' }))
    await waitFor(() => expect(onReadCall).toHaveBeenCalledWith('find/r1/0/security'))
    expect(await within(row).findByText('finder transcript')).toBeVisible()
  })

  it('shows a failed ranking with its reason and its logs instead of a blank stage', async () => {
    const view = discoverRunView()
    const failed: LocalWorkflowView = {
      ...view,
      state: 'failed',
      result: undefined,
      actions: ['retry'],
      stages: view.stages.map((stage) =>
        stage.id === 'rank' ? { ...stage, completed: 0, failed: 1 } : stage
      ),
      calls: view.calls.map((call) =>
        call.id === 'rank/final'
          ? { ...call, state: 'failed', error: 'timed out after 10:00' }
          : call
      ),
      discoverRun: { ...view.discoverRun!, report: undefined }
    }
    const onReadCall = vi.fn().mockResolvedValue({
      stdout: 'ranker transcript',
      stderr: '',
      outputTruncated: false
    })
    render(<LocalWorkflowExecutionView view={failed} onReadCall={onReadCall} />)
    const rank = screen
      .getByRole('list', { name: 'Discover stages' })
      .querySelector<HTMLElement>('[data-stage-id="rank"]')!
    expect(rank).toHaveAttribute('data-stage-tone', 'failed')
    expect(
      within(rank).getByText("Claude Opus 5 didn't finish: timed out after 10:00")
    ).toBeVisible()
    fireEvent.click(within(rank).getByRole('button', { name: 'Details' }))
    await waitFor(() => expect(onReadCall).toHaveBeenCalledWith('rank/final'))
    expect(await within(rank).findByText('ranker transcript')).toBeVisible()
  })

  it('says when the finders found nothing and names each skipped piece of work once', () => {
    const view = discoverRunView()
    const run = view.discoverRun!
    const empty: LocalWorkflowView = {
      ...view,
      discoverRun: {
        ...run,
        findings: [],
        report: { summary: 'Nothing held up.', items: [] },
        counts: { found: 0, duplicates: 0, verifying: 0, confirmed: 0, refuted: 0, unverified: 0 },
        dropped: [run.dropped[0], run.dropped[0]]
      }
    }
    render(<LocalWorkflowExecutionView view={empty} />)
    fireEvent.click(screen.getByRole('button', { name: /Find/ }))
    expect(screen.getByText('The finders reported no defects.')).toBeVisible()
    // Skipped work is listed in the run's Notes, one click away, not unfolded under the stages.
    expect(screen.queryByText('Round 3 skipped: the agent limit was reached.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Notes · 1' }))
    expect(screen.getAllByText('Round 3 skipped: the agent limit was reached.')).toHaveLength(1)
    expect(screen.getByText('(×2)')).toBeVisible()
  })

  it('shows findings the moment they are found, while verifiers still vote', () => {
    const view = discoverRunView()
    const run = view.discoverRun!
    const live: LocalWorkflowView = {
      ...view,
      state: 'running',
      finishedAt: undefined,
      result: undefined,
      running: 2,
      calls: [workflowCall('scout/map', 'seat-1'), workflowCall('find/r1/0/correctness', 'seat-2')],
      stages: [
        { id: 'scout', label: 'Scout', completed: 1, total: 1, failed: 0 },
        { id: 'find', label: 'Find', completed: 1, total: 3, failed: 0 },
        { id: 'verify', label: 'Verify', completed: 0, total: 3, failed: 0 },
        { id: 'rank', label: 'Rank', completed: 0, failed: 0 }
      ],
      discoverRun: {
        ...run,
        report: undefined,
        findings: [
          {
            ...run.findings[0],
            status: 'verifying',
            votes: run.findings[0].votes.map((vote, index) =>
              index === 0 ? vote : { ...vote, state: 'running', verdict: undefined }
            )
          }
        ]
      }
    }
    render(<LocalWorkflowExecutionView view={live} />)
    expect(screen.getByText('Checkout')).toBeVisible()
    const card = screen.getByRole('button', { name: /Retry drops the idempotency key/ })
    expect(card).toHaveTextContent('Verifying')
    expect(card).toHaveTextContent('1 real, 0 refuted, 0 unjudged')
    expect(screen.queryByRole('region', { name: 'Report' })).toBeNull()
  })

  it('says a finding waits to verify until one of its votes has started', () => {
    const view = discoverRunView()
    const run = view.discoverRun!
    const waiting: LocalWorkflowView = {
      ...view,
      state: 'running',
      finishedAt: undefined,
      result: undefined,
      running: 1,
      calls: [workflowCall('scout/map', 'seat-1'), workflowCall('find/r1/0/correctness', 'seat-2')],
      stages: [
        { id: 'scout', label: 'Scout', completed: 1, total: 1, failed: 0 },
        { id: 'find', label: 'Find', completed: 1, total: 3, failed: 0 },
        { id: 'verify', label: 'Verify', completed: 0, total: 0, failed: 0 },
        { id: 'rank', label: 'Rank', completed: 0, failed: 0 }
      ],
      discoverRun: {
        ...run,
        report: undefined,
        counts: { found: 1, duplicates: 0, verifying: 1, confirmed: 0, refuted: 0, unverified: 0 },
        findings: [
          {
            ...run.findings[0],
            status: 'verifying',
            votes: run.findings[0].votes.map((vote) => ({
              ...vote,
              state: 'pending',
              verdict: undefined
            }))
          }
        ]
      }
    }
    const { rerender } = render(<LocalWorkflowExecutionView view={waiting} />)
    const card = () => screen.getByRole('button', { name: /Retry drops the idempotency key/ })
    expect(card()).toHaveTextContent('Waiting to verify')
    // The Verify stage counts it the same way as its card.
    expect(
      screen.getByText('1 waiting to verify · 0 confirmed · 0 refuted · 0 unverified')
    ).toBeVisible()
    const [first, ...rest] = waiting.discoverRun!.findings[0].votes
    const withVotes = (votes: typeof rest): LocalWorkflowView => ({
      ...waiting,
      discoverRun: {
        ...waiting.discoverRun!,
        findings: [{ ...waiting.discoverRun!.findings[0], votes }]
      }
    })
    rerender(
      <LocalWorkflowExecutionView view={withVotes([{ ...first, state: 'running' }, ...rest])} />
    )
    expect(card()).toHaveTextContent('Verifying')
    expect(card()).not.toHaveTextContent('Waiting to verify')
    expect(screen.getByText('1 verifying · 0 confirmed · 0 refuted · 0 unverified')).toBeVisible()
    // One vote in and the next two still queued: it does not go back to waiting.
    rerender(
      <LocalWorkflowExecutionView
        view={withVotes([{ ...first, state: 'done', verdict: 'real' }, ...rest])}
      />
    )
    expect(card()).toHaveTextContent('Verifying')
    expect(card()).not.toHaveTextContent('Waiting to verify')
    expect(screen.getByText('1 verifying · 0 confirmed · 0 refuted · 0 unverified')).toBeVisible()
  })
})
