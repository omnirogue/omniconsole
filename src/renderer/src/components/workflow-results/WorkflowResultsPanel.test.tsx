// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { workflowView } from '../local-workflows/local-workflow-ui.fixtures'
import type { WorkflowResultCandidate, WorkflowResults } from './workflow-results-candidates'
import { WorkflowResultsPanel } from './WorkflowResultsPanel'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, values?: Record<string, string | number>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(values?.[key] ?? ''))
}))
vi.mock('./WorkflowResultsLaunchDialog', () => ({
  WorkflowResultsLaunchDialog: ({ chosen }: { chosen: WorkflowResultCandidate[] }) => (
    <div role="dialog">{chosen.map((entry) => entry.title).join(', ')}</div>
  )
}))
afterEach(cleanup)

const option = (key: string, change: Partial<WorkflowResultCandidate> = {}) => ({
  id: `run-1:${key}`,
  key,
  title: `Option ${key}`,
  detail: '',
  preselected: false,
  ...change
})

const FIND: WorkflowResults = {
  kind: 'find',
  considered: 40,
  candidates: [
    option('o2', { winner: true, score: 3.5, place: 1, preselected: true }),
    option('o1', { score: 3, check: { passed: false, score: 2 } }),
    option('o3')
  ]
}
const TARGET = { worktreeId: 'wt-1', tabId: 'tab-1' }

describe('WorkflowResultsPanel', () => {
  it('says who wrote a reason, and shows the app\u2019s check of its quote beside it', () => {
    const results: WorkflowResults = {
      kind: 'items',
      candidates: [
        option('r1', {
          rank: 1,
          tally: 'confirmed',
          why: 'W1 found in the page: "fabricated"',
          webChecks: [{ id: 'W1', mark: 'not-in-page', quote: 'fabricated' }]
        })
      ]
    }
    render(<WorkflowResultsPanel view={workflowView()} results={results} target={TARGET} />)
    const label = document.querySelector('[data-model-written]')!
    expect(label).toHaveTextContent('The report\u2019s model wrote:')
    expect(label.parentElement).toHaveTextContent(
      'The report\u2019s model wrote: W1 found in the page: "fabricated"'
    )
    const checks = document.querySelector('[data-workflow-web-checks="compact"]')!
    expect(checks).toHaveTextContent('App quote checks: W1 NOT in the page \u201cfabricated\u201d')
  })

  it('starts with the winner ticked and offers what the chosen options allow', () => {
    const onFindNextStep = vi.fn()
    render(
      <WorkflowResultsPanel
        view={workflowView()}
        results={FIND}
        target={TARGET}
        onFindNextStep={onFindNextStep}
      />
    )
    expect(screen.getByText('1 of 3 chosen')).toBeInTheDocument()
    expect(screen.getByText('winner')).toBeInTheDocument()
    expect(screen.getByText('check failed (SCORE 2)')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Improve it' }))
    expect(onFindNextStep).toHaveBeenLastCalledWith('improve', ['o2'])
    fireEvent.click(screen.getByRole('button', { name: 'Build with this' }))
    expect(onFindNextStep).toHaveBeenLastCalledWith('build', ['o2'])
    fireEvent.click(screen.getByRole('checkbox', { name: 'Option o1' }))
    expect(screen.getByText('2 of 3 chosen')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Improve it' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Build with this' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Combine these 2' }))
    // In the results' order, best first.
    expect(onFindNextStep).toHaveBeenLastCalledWith('combine', ['o2', 'o1'])
    fireEvent.click(screen.getByRole('button', { name: 'Look closer' }))
    expect(onFindNextStep).toHaveBeenLastCalledWith('look-closer', ['o2', 'o1'])
  })

  it('selects all or none, and starts a session with exactly the chosen ones', () => {
    render(<WorkflowResultsPanel view={workflowView()} results={FIND} target={TARGET} />)
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }))
    expect(screen.getByText('3 of 3 chosen')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(screen.getByText('0 of 3 chosen')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start a session (0)' })).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Option o3' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Option o1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Start a session (2)' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Option o1, Option o3')
  })

  it('ticks the findings that held up and shows each verdict and location', () => {
    render(
      <WorkflowResultsPanel
        view={workflowView()}
        results={{
          kind: 'discover',
          candidates: [
            option('a', {
              tally: 'confirmed',
              severity: 'high',
              location: 'src/pay.ts:142',
              jev: { score: 2.5 },
              preselected: true
            }),
            option('b', { tally: 'refuted' }),
            option('c', { tally: 'unverified', unchecked: true, screened: true })
          ]
        }}
        target={TARGET}
        onFindNextStep={vi.fn()}
      />
    )
    expect(screen.getByText('1 of 3 chosen')).toBeInTheDocument()
    // Set aside by JEV: said so, instead of an unverified verdict nobody gave.
    expect(screen.getByText('set aside by JEV')).toBeInTheDocument()
    expect(screen.queryByText('no reviewer saw it')).toBeNull()
    expect(screen.getByRole('checkbox', { name: 'Option a' })).toBeChecked()
    expect(screen.getByText('Confirmed')).toBeInTheDocument()
    expect(screen.getByText('src/pay.ts:142')).toBeInTheDocument()
    expect(screen.getByText('JEV 2.5/4')).toBeInTheDocument()
    // Improve and Look closer belong to Find the best.
    expect(screen.queryByRole('button', { name: 'Look closer' })).toBeNull()
  })

  it("says in plain words whether the app found each finding's quote in the file", () => {
    render(
      <WorkflowResultsPanel
        view={workflowView()}
        results={{
          kind: 'discover',
          candidates: [
            option('a', { tally: 'confirmed', evidence: 'found' }),
            option('b', { tally: 'confirmed', evidence: 'missing' }),
            option('c', { tally: 'unverified', evidence: 'unreadable' }),
            option('d', { tally: 'unverified', evidence: 'moved' }),
            option('e', { tally: 'unverified', evidence: 'not-code' })
          ]
        }}
        target={TARGET}
      />
    )
    expect(screen.getByText('quote checked in the file')).toBeInTheDocument()
    expect(screen.getByText('quote not found in the file')).toBeInTheDocument()
    expect(screen.getByText('file could not be read')).toBeInTheDocument()
    expect(screen.getByText('quote found elsewhere in the file')).toBeInTheDocument()
    // A missing quote is only flagged: the finding keeps its reviewers' verdict.
    expect(screen.getAllByText('Confirmed')).toHaveLength(2)
  })

  it('shows nothing where nothing can be started', () => {
    const { container } = render(<WorkflowResultsPanel view={workflowView()} results={FIND} />)
    expect(container).toBeEmptyDOMElement()
  })
})
