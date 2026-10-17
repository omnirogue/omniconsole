// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildReviewGraphView } from '@/lib/local-graph-build-review'
import { localRunGraphView } from '@/lib/local-graph-view'
import { pipelineFixture } from '../build-review/build-review-test-fixture'
import { LocalRunGraphPanel } from './LocalRunGraphPanel'
import { localRunFixture, localRunNodeFixture } from './local-run-test-fixture'

const mocks = vi.hoisted(() => ({
  dot: vi.fn(),
  download: vi.fn(),
  portals: vi.fn(),
  rpc: vi.fn(),
  state: {
    tabsByWorktree: {
      'workspace-1': [{ id: 'tab-1', ptyId: 'term_b' }]
    },
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {
      'tab-1': {
        activeLeafId: '11111111-1111-4111-8111-111111111111',
        ptyIdsByLeafId: { '11111111-1111-4111-8111-111111111111': 'term_b' }
      }
    }
  } as Record<string, unknown>
}))

// Why i18n: the worker card draws AgentIcon, whose catalog reads the active language on load.
vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, english: string) => english
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector(mocks.state)
}))
vi.mock('@/components/AgentStateDot', () => ({
  AgentStateDot: ({ state }: { state: string }) => {
    mocks.dot(state)
    return <span data-testid="state-dot" data-state={state} />
  },
  agentStateLabel: (state: string) => state
}))
vi.mock('@/lib/console-workflow-client', () => ({ downloadWorkflowExport: mocks.download }))
vi.mock('../activity/activity-terminal-portal', () => ({
  setActivityTerminalPortals: mocks.portals
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.rpc.mockResolvedValue({ run: localRunFixture() })
})
afterEach(cleanup)

describe('the canvas rendering a local run', () => {
  it('draws every step with its state, its workspace folder and what it produced', () => {
    const run = localRunFixture()
    render(<LocalRunGraphPanel view={localRunGraphView(run)} run={run} />)
    expect(screen.getByRole('region', { name: 'Graph' })).toBeInTheDocument()
    for (const id of ['cut-a', 'cut-b', 'fold']) {
      expect(screen.getAllByText(id).length).toBeGreaterThan(0)
    }
    expect(screen.getAllByText('Completed').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Running').length).toBeGreaterThan(0)
    expect(screen.getByText('Queued')).toBeInTheDocument()
    // The folder each step ran in, never a branch and never "worktree".
    expect(
      screen.getAllByTitle('/Users/me/Webinar/.omni/runs/run_1/task_a').length
    ).toBeGreaterThan(0)
    expect(screen.getByText('Workspace: /Users/me/Webinar')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('worktree')
    // The first step is selected by default and shows its produced file in full.
    expect(
      screen.getByText('/Users/me/Webinar/.omni/runs/run_1/task_a/cut-a.mp4')
    ).toBeInTheDocument()
    expect(
      screen.getByText('/Users/me/Webinar/.omni/runs/run_1/task_a/manifest.md')
    ).toBeInTheDocument()
    expect(mocks.dot).toHaveBeenCalledWith('done')
    expect(mocks.dot).toHaveBeenCalledWith('working')
    expect(mocks.dot).toHaveBeenCalledWith('idle')
  })

  it('shows the selected step, not the first one, once a person picks it', () => {
    const run = localRunFixture()
    render(<LocalRunGraphPanel view={localRunGraphView(run)} run={run} />)
    fireEvent.click(screen.getByRole('button', { name: /cut-b/ }))
    expect(screen.getByRole('complementary', { name: 'Step details' })).toHaveTextContent(
      'Produce cut B'
    )
    expect(screen.getByText('This step has not produced any file yet.')).toBeInTheDocument()
  })

  it('lends the running step its own live pane instead of opening a second terminal', () => {
    const run = localRunFixture()
    const view = localRunGraphView(run)
    const { unmount } = render(<LocalRunGraphPanel view={view} run={run} />)
    fireEvent.click(screen.getByRole('button', { name: /cut-b/ }))
    expect(screen.getByLabelText('Live pane for this step')).toBeInTheDocument()
    const published = mocks.portals.mock.calls.at(-1)?.[0]
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({
      slotId: 'local-run-node-pane',
      worktreeId: 'workspace-1',
      tabId: 'tab-1',
      paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
      active: true
    })
    unmount()
    expect(mocks.portals).toHaveBeenLastCalledWith([], expect.stringMatching(/^localRuns:/))
  })

  it('mounts the answer form for the step waiting on a person', () => {
    const run = localRunFixture({
      nodes: [
        localRunNodeFixture({
          id: 'cut-a',
          state: 'needs-input',
          gateId: 'gate_1',
          gateQuestion: 'Publish this cut?'
        })
      ]
    })
    render(<LocalRunGraphPanel view={localRunGraphView(run)} run={run} />)
    expect(screen.getByText('Waiting for you')).toBeInTheDocument()
    expect(screen.getAllByText('Publish this cut?').length).toBeGreaterThan(0)
  })

  it('lanes the stored events by step on the timeline', () => {
    const run = localRunFixture()
    render(<LocalRunGraphPanel view={localRunGraphView(run)} run={run} />)
    // Radix selects a tab on pointer-down, not on the synthetic click alone.
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Timeline' }))
    expect(screen.getByRole('region', { name: 'Run' })).toHaveTextContent('Created 3 task(s)')
    expect(screen.getByRole('region', { name: 'cut-a' })).toHaveTextContent('cut-a produced 1 file')
    expect(screen.getByRole('region', { name: 'fold' })).toHaveTextContent('Nothing recorded yet.')
  })

  it('exports the same graph as JSON and Mermaid', () => {
    const run = localRunFixture()
    render(<LocalRunGraphPanel view={localRunGraphView(run)} run={run} />)
    fireEvent.click(screen.getByRole('button', { name: 'Export Mermaid' }))
    expect(mocks.download).toHaveBeenCalledWith(
      expect.stringContaining('flowchart LR'),
      'mermaid',
      'local-run-lrn_1.mmd'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Export JSON' }))
    expect(mocks.download).toHaveBeenLastCalledWith(
      expect.stringContaining('"source": "local-run"'),
      'json',
      'local-run-lrn_1.json'
    )
  })

  it('stops a running local run through the runner, never by killing a terminal', async () => {
    const run = localRunFixture()
    render(<LocalRunGraphPanel view={localRunGraphView(run)} run={run} />)
    fireEvent.click(screen.getByRole('button', { name: 'Stop this run' }))
    expect(mocks.rpc).toHaveBeenCalledWith({ kind: 'local' }, 'localRun.cancel', { id: 'lrn_1' })
  })
})

describe('the canvas rendering a Build + Review', () => {
  it('draws the loop back to the builder with its round counter', () => {
    render(
      <LocalRunGraphPanel
        view={buildReviewGraphView(pipelineFixture({ round: 2, maxReviewRounds: 5 }))}
      />
    )
    expect(screen.getAllByText('builder').length).toBeGreaterThan(0)
    expect(screen.getByText(/Round 2\/5/)).toBeInTheDocument()
    // A pipeline is not a local Run: there is nothing here to stop through localRun.cancel.
    expect(screen.queryByRole('button', { name: 'Stop this run' })).not.toBeInTheDocument()
    expect(screen.getByText('src/search.tsx')).toBeInTheDocument()
  })
})
