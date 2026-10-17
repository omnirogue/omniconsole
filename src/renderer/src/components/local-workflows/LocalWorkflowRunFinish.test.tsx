// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LocalWorkflowView } from '../../../../shared/local-workflow-view'
import { LocalWorkflowExecutionView } from './LocalWorkflowExecutionView'
import {
  completedCouncilRunView,
  councilRunView,
  discoverRunView
} from './local-workflow-run.fixtures'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, values?: Record<string, string | number>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(values?.[key] ?? ''))
}))
vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: ({ agent }: { agent: string }) => <span data-agent-icon={agent} />
}))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/**
 * Why these tests exist: in live acceptance a run that finished while open kept all 65 finding
 * cards and every agent list expanded above its report, the chairman's prose still said
 * "Response A", program log lines sat in the header and no usage was shown.
 */
function stage(id: string): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-stage-id="${id}"]`)!
}

function runningDiscover(): LocalWorkflowView {
  const view = discoverRunView()
  return {
    ...view,
    state: 'running',
    finishedAt: undefined,
    result: undefined,
    running: 1,
    actions: ['pause', 'stop'],
    discoverRun: { ...view.discoverRun!, report: undefined }
  }
}

describe('a run that finishes while it is open', () => {
  it('folds the Council stages at once and leads with the chairman', () => {
    const { rerender } = render(<LocalWorkflowExecutionView view={councilRunView()} />)
    expect(screen.getByRole('heading', { name: 'Use an idempotency key' })).toBeVisible()
    rerender(<LocalWorkflowExecutionView view={completedCouncilRunView()} />)
    expect(screen.queryByRole('heading', { name: 'Use an idempotency key' })).toBeNull()
    expect(screen.queryByText('Extracted ranking')).toBeNull()
    const chair = screen.getByRole('region', { name: "Chairman's answer" })
    expect(within(chair).getByRole('heading', { name: 'Verdict' })).toBeVisible()
    // Folded, not lost: each stage reopens from its header.
    fireEvent.click(within(stage('answer')).getByRole('button', { name: /First opinions/ }))
    expect(screen.getByRole('heading', { name: 'Use an idempotency key' })).toBeVisible()
  })

  it('folds the Discover findings and brings an off-screen report into view', () => {
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
    const { rerender } = render(<LocalWorkflowExecutionView view={runningDiscover()} />)
    expect(within(stage('find')).getByText('Currency rounding loses a cent')).toBeVisible()
    expect(scrolled).not.toHaveBeenCalled()
    // The report lands below the fold: the reader was deep in the findings.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ top: 5_000 } as DOMRect)
    rerender(<LocalWorkflowExecutionView view={discoverRunView()} />)
    expect(within(stage('find')).queryByText('Currency rounding loses a cent')).toBeNull()
    expect(within(stage('rank')).getByRole('region', { name: 'Report' })).toBeVisible()
    expect(scrolled).toHaveBeenCalledTimes(1)
    expect(scrolled.mock.contexts[0]).toBe(stage('rank'))
  })

  it('measures the report against the run pane, not the window', () => {
    // Why: the run pane can be shorter than the window; a report just below the pane's edge
    // still sat above the window's bottom and was never brought into view.
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
    let reportTop = 450
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: Element) {
        const pane = this instanceof HTMLElement && this.dataset.testid === 'pane'
        return (pane ? { top: 100, bottom: 400 } : { top: reportTop }) as DOMRect
      }
    )
    const finishInPane = () => {
      const inPane = (view: LocalWorkflowView) => (
        <div data-testid="pane" style={{ overflowY: 'auto' }}>
          <LocalWorkflowExecutionView view={view} />
        </div>
      )
      const { rerender } = render(inPane(runningDiscover()))
      const pane = screen.getByTestId('pane')
      Object.defineProperty(pane, 'scrollHeight', { configurable: true, value: 4_000 })
      Object.defineProperty(pane, 'clientHeight', { configurable: true, value: 300 })
      rerender(inPane(discoverRunView()))
    }
    expect(reportTop).toBeLessThan(window.innerHeight)
    finishInPane()
    expect(scrolled).toHaveBeenCalledTimes(1)
    expect(scrolled.mock.contexts[0]).toBe(stage('rank'))
    // A report already readable inside the pane stays where it is.
    cleanup()
    scrolled.mockClear()
    reportTop = 150
    finishInPane()
    expect(scrolled).not.toHaveBeenCalled()
  })

  it('does not scroll a run that was already finished when it opened', () => {
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ top: 5_000 } as DOMRect)
    render(<LocalWorkflowExecutionView view={discoverRunView()} />)
    expect(scrolled).not.toHaveBeenCalled()
  })
})

describe('Council answer', () => {
  it("names the models in the chairman's answer and copies it that way", async () => {
    const writeClipboardText = vi.fn().mockResolvedValue(undefined)
    Object.assign(window, { api: { ui: { writeClipboardText } } })
    const view = completedCouncilRunView()
    view.result = {
      markdown: 'Response B is right; Responses A and C miss the retry. A lone B stays.',
      sources: [],
      coverage: []
    }
    render(<LocalWorkflowExecutionView view={view} />)
    const chair = screen.getByRole('region', { name: "Chairman's answer" })
    expect(chair).not.toHaveTextContent('Response B')
    expect(within(chair).getByText('GPT-5.6 Sol', { selector: 'strong' })).toBeVisible()
    expect(within(chair).getByText('Grok 4.6', { selector: 'strong' })).toBeVisible()
    expect(chair).toHaveTextContent('A lone B stays.')
    fireEvent.click(within(chair).getByRole('button', { name: 'Copy answer' }))
    await waitFor(() =>
      expect(writeClipboardText).toHaveBeenCalledWith(
        '**GPT-5.6 Sol** is right; **Claude Opus 5** and **Grok 4.6** miss the retry. A lone B stays.'
      )
    )
  })
})

describe('Council answer before the result lands', () => {
  it("names the models in the chairman's finished call while the run is still settling", () => {
    // Why: between the chair call finishing and the run's result landing, the raw call text
    // showed "Response B" for a moment.
    const done = completedCouncilRunView()
    const view: LocalWorkflowView = {
      ...done,
      state: 'running',
      finishedAt: undefined,
      result: undefined,
      calls: done.calls.map((call) =>
        call.id === 'chair/final'
          ? { ...call, resultMarkdown: 'Response B is right; Response A misses the retry.' }
          : call
      )
    }
    render(<LocalWorkflowExecutionView view={view} />)
    const chair = screen.getByRole('region', { name: "Chairman's answer" })
    expect(chair).not.toHaveTextContent('Response B')
    expect(within(chair).getByText('GPT-5.6 Sol', { selector: 'strong' })).toBeVisible()
    expect(within(chair).getByText('Claude Opus 5', { selector: 'strong' })).toBeVisible()
  })
})

describe('run error', () => {
  it('gives a bare run-level code plain words and keeps the code one click away', () => {
    // Why: a run-level code became a generic line pointing at Details, but runs had no Details,
    // so the code the host reported was shown nowhere.
    const view: LocalWorkflowView = {
      ...councilRunView(),
      state: 'failed',
      actions: [],
      error: 'worker_exit_unclean'
    }
    render(<LocalWorkflowExecutionView view={view} />)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('The run stopped unexpectedly. Details has the full report.')
    expect(alert).not.toHaveTextContent('worker_exit_unclean')
    fireEvent.click(within(alert).getByRole('button', { name: 'Details' }))
    expect(within(alert).getByText('Reported: worker_exit_unclean')).toBeVisible()
  })

  it('shows a readable run error as written, with no Details', () => {
    const view: LocalWorkflowView = {
      ...councilRunView(),
      state: 'failed',
      actions: [],
      error: 'The chairman did not answer.'
    }
    render(<LocalWorkflowExecutionView view={view} />)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('The chairman did not answer.')
    expect(within(alert).queryByRole('button', { name: 'Details' })).toBeNull()
  })
})

describe('run notes and usage', () => {
  it("lists Discover's skipped work once in Notes, whether or not the live log is still there", () => {
    // Why: the cap lines showed twice (unfolded under the stages and in Notes) while the live
    // log lasted, and only unfolded after a restart.
    const cap = 'Round 1: the finder left out 2 more findings beyond its limit of 8.'
    const view = discoverRunView()
    const withDropped = (log?: string[]): LocalWorkflowView => ({
      ...view,
      log,
      discoverRun: { ...view.discoverRun!, dropped: [cap, cap] }
    })
    render(<LocalWorkflowExecutionView view={withDropped([cap, 'Scout mapped 2 areas.'])} />)
    expect(screen.queryByText(/limit of 8/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Notes · 2' }))
    expect(screen.getAllByText(/limit of 8/)).toHaveLength(1)
    expect(screen.getByText('(×2)')).toBeVisible()
    cleanup()
    // After a restart the live log is gone; the skipped work is still in Notes.
    render(<LocalWorkflowExecutionView view={withDropped(undefined)} />)
    expect(screen.queryByText(/limit of 8/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Notes · 1' }))
    expect(screen.getAllByText(/limit of 8/)).toHaveLength(1)
    expect(screen.getByText('(×2)')).toBeVisible()
  })

  it('keeps program log lines out of the header, in a folded Notes list', () => {
    const view = {
      ...councilRunView(),
      log: [
        'Round 1: the finder left out 2 more findings beyond its limit of 8.',
        'Round 1: the finder left out 2 more findings beyond its limit of 8.',
        'Grok 4.6 did not answer; the council continues without it.'
      ]
    }
    render(<LocalWorkflowExecutionView view={view} />)
    expect(screen.getByRole('status')).not.toHaveTextContent('limit of 8')
    expect(screen.queryByText(/limit of 8/)).toBeNull()
    const notes = screen.getByRole('region', { name: 'Notes' })
    fireEvent.click(within(notes).getByRole('button', { name: 'Notes · 2' }))
    expect(within(notes).getByText(/limit of 8/)).toBeVisible()
    expect(within(notes).getByText('(×2)')).toBeVisible()
  })

  it('shows tokens used under the result, and never a price', () => {
    const view: LocalWorkflowView = {
      ...completedCouncilRunView(),
      usage: {
        hostAttempts: 8,
        maxHostAttempts: 21,
        tokens: { kind: 'reported', input: 312_400, output: 32_100 }
      }
    }
    render(<LocalWorkflowExecutionView view={view} />)
    const chair = screen.getByRole('region', { name: "Chairman's answer" })
    expect(within(chair).getByText('344.5k tokens used · 312.4k in · 32.1k out')).toBeVisible()
    expect(chair).not.toHaveTextContent('$')
  })

  it('says a usage figure is estimated, and shows one for a run that ended without a result', () => {
    const view: LocalWorkflowView = {
      ...councilRunView(),
      state: 'failed',
      actions: [],
      usage: {
        hostAttempts: 3,
        maxHostAttempts: 21,
        tokens: { kind: 'estimated', input: 2_000, output: 500 }
      }
    }
    render(<LocalWorkflowExecutionView view={view} />)
    expect(screen.getByText('About 2.5k tokens used (estimated) · 2k in · 500 out')).toBeVisible()
  })
})
