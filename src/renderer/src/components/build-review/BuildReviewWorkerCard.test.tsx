// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { BuildReviewWorkerSnapshot } from '../../../../shared/build-review-pipeline'
import { BuildReviewWaitingRow, BuildReviewWorkerCard } from './BuildReviewWorkerCard'

const NOW = 1_000_000_000

const mocks = vi.hoisted(() => ({
  state: { agentStatusByPaneKey: {} as Record<string, unknown> } as Record<string, unknown>,
  focus: vi.fn(),
  rpc: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector(mocks.state)
}))
vi.mock('@/i18n/i18n', () => ({
  // AgentIcon's catalog reads the active language when it loads.
  i18n: { language: 'en' },
  translate: (_key: string, english: string, args?: Record<string, unknown>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(args?.[key] ?? ''))
}))
vi.mock('@/hooks/use-now', () => ({ useNow: vi.fn(() => NOW) }))
vi.mock('@/components/AgentStateDot', () => ({
  AgentStateDot: ({ state }: { state: string }) => (
    <span data-testid="state-dot" data-state={state} />
  )
}))
vi.mock('@/components/sidebar/CommentMarkdown', () => ({
  default: ({ content, variant }: { content: string; variant?: string }) => (
    <div data-testid="markdown" data-variant={variant}>
      {content}
    </div>
  )
}))
vi.mock('../local-run/LocalRunLivePane', () => ({
  LocalRunLivePane: ({ handle }: { handle: string | null }) => (
    <div data-testid="live-pane" data-handle={handle} />
  )
}))
vi.mock('@/components/terminal-pane/terminal-handle-links', () => ({
  focusRendererTerminalHandle: mocks.focus
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))

function worker(overrides: Partial<BuildReviewWorkerSnapshot> = {}): BuildReviewWorkerSnapshot {
  return {
    role: 'builder',
    choice: { agent: 'codex', model: 'gpt-5.5', effort: 'high' },
    status: 'running',
    taskId: 'task-1',
    dispatchId: 'ctx_1',
    terminalHandle: 'term_builder',
    report: null,
    error: null,
    ...overrides
  }
}

function hookRow(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'working',
    prompt: '',
    updatedAt: NOW - 1_000,
    stateStartedAt: NOW - 125_000,
    paneKey: 'tab-1:leaf-1',
    terminalHandle: 'term_builder',
    stateHistory: [],
    toolName: 'Edit',
    toolInput: 'src/x.ts',
    lastAssistantMessage: 'Adding the keyboard handler now.',
    ...overrides
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.state = { agentStatusByPaneKey: {} }
  mocks.focus.mockReturnValue(true)
})
afterEach(cleanup)

describe('BuildReviewWorkerCard live state', () => {
  it('follows the running worker through its agent hook row', () => {
    mocks.state = {
      agentStatusByPaneKey: {
        'other:leaf': hookRow({ terminalHandle: 'term_other', toolInput: 'src/other.ts' }),
        'tab-1:leaf-1': hookRow()
      }
    }
    render(<BuildReviewWorkerCard worker={worker()} live liveTerminal />)
    expect(screen.getByTestId('state-dot')).toHaveAttribute('data-state', 'working')
    expect(screen.getByText('Editing src/x.ts')).toBeInTheDocument()
    expect(screen.getByText('2m 05s')).toBeInTheDocument()
    expect(screen.getByText('Adding the keyboard handler now.')).toBeInTheDocument()
    expect(screen.getByTestId('live-pane')).toHaveAttribute('data-handle', 'term_builder')
    // The inline terminal folds away without losing the way into the real one.
    fireEvent.click(screen.getByRole('button', { name: /Hide live terminal/ }))
    expect(screen.queryByTestId('live-pane')).toBeNull()
    expect(screen.getByRole('button', { name: /Show live terminal/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open terminal' })).toBeEnabled()
  })

  it("offers the running worker's terminal tab where the surface cannot lend it inline", async () => {
    mocks.state = { agentStatusByPaneKey: { 'tab-1:leaf-1': hookRow() } }
    render(<BuildReviewWorkerCard worker={worker()} live />)
    expect(screen.getByText('Editing src/x.ts')).toBeInTheDocument()
    expect(screen.queryByTestId('live-pane')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open terminal' })).toBeNull()
    expect(screen.getByText("Opens the worker's terminal in its own tab.")).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show live terminal' }))
    await waitFor(() => expect(mocks.focus).toHaveBeenCalledWith('term_builder', null))
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('opens a finished worker terminal through the host when this window has not mounted it', async () => {
    mocks.focus.mockReturnValue(false)
    render(<BuildReviewWorkerCard worker={worker({ status: 'succeeded' })} live />)
    expect(screen.queryByRole('button', { name: 'Show live terminal' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }))
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith({ kind: 'local' }, 'terminal.focus', {
        terminal: 'term_builder',
        navigation: 'host'
      })
    )
  })

  it('shows a failed turn as failed, not finished', () => {
    mocks.state = {
      agentStatusByPaneKey: {
        'tab-1:leaf-1': hookRow({
          state: 'done',
          failed: true,
          failureReason: 'Rate limit reached'
        })
      }
    }
    render(<BuildReviewWorkerCard worker={worker()} live />)
    expect(screen.getByTestId('state-dot')).toHaveAttribute('data-state', 'failed')
    expect(screen.getByText('Its last turn failed: Rate limit reached')).toBeInTheDocument()
  })

  it('shows a permission wait from the hook as the worker state', () => {
    mocks.state = {
      agentStatusByPaneKey: { 'tab-1:leaf-1': hookRow({ state: 'waiting', toolName: 'Bash' }) }
    }
    render(<BuildReviewWorkerCard worker={worker()} live />)
    expect(screen.getByTestId('state-dot')).toHaveAttribute('data-state', 'waiting')
    expect(screen.getByText('Waiting for permission: Bash')).toBeInTheDocument()
  })

  it('says Running, not Starting, once the starting agent is at work', () => {
    mocks.state = { agentStatusByPaneKey: { 'tab-1:leaf-1': hookRow() } }
    render(<BuildReviewWorkerCard worker={worker({ status: 'starting' })} live />)
    expect(screen.getByText('Running')).toBeInTheDocument()
    expect(screen.queryByText('Starting')).toBeNull()
    expect(screen.getByText('Editing src/x.ts')).toBeInTheDocument()
    cleanup()
    // Still at its startup question: the person's turn, so it is still starting.
    render(
      <BuildReviewWorkerCard
        worker={worker({ status: 'starting', startupBlocker: 'codex-hooks-review-prompt' })}
        live
      />
    )
    expect(screen.getByText('Starting')).toBeInTheDocument()
  })

  it('stays live without a hook row yet, and does not read hooks when not live', () => {
    render(<BuildReviewWorkerCard worker={worker({ status: 'starting' })} live />)
    expect(screen.getByText('Starting the agent…')).toBeInTheDocument()
    cleanup()
    mocks.state = { agentStatusByPaneKey: { 'tab-1:leaf-1': hookRow() } }
    render(<BuildReviewWorkerCard worker={worker()} state="done" badge="Completed" />)
    expect(screen.getByTestId('state-dot')).toHaveAttribute('data-state', 'done')
    expect(screen.getByText('Completed')).toBeInTheDocument()
    expect(screen.queryByText('Editing src/x.ts')).toBeNull()
    expect(screen.queryByTestId('live-pane')).toBeNull()
  })
})

describe('BuildReviewWorkerCard report', () => {
  it('renders a reviewer report as document markdown with severity chips and its verdict', () => {
    const body = [
      '- **BLOCKER** src/a.ts:1 crashes',
      '- MAJOR: src/b.ts:2 focus lost',
      '- MAJOR: src/c.ts:3 wrong default',
      '',
      '**VERDICT: REQUEST_CHANGES**'
    ].join('\n')
    render(
      <BuildReviewWorkerCard
        worker={worker({
          role: 'reviewer',
          status: 'succeeded',
          report: {
            subject: 'Two problems',
            body,
            outcome: 'succeeded',
            filesModified: [],
            reportPath: null,
            reportedAt: '2026-09-21T12:00:00Z'
          }
        })}
        title="Reviewer 1"
        live
      />
    )
    expect(screen.getByRole('region', { name: 'Reviewer 1' })).toBeInTheDocument()
    expect(screen.getByTestId('markdown')).toHaveAttribute('data-variant', 'document')
    expect(screen.getByTestId('markdown')).toHaveTextContent('focus lost')
    expect(document.querySelector('[data-build-review-severity="blocker"]')).toHaveTextContent(
      'Blocker1'
    )
    expect(document.querySelector('[data-build-review-severity="major"]')).toHaveTextContent(
      'Major2'
    )
    expect(document.querySelector('[data-build-review-severity="minor"]')).toBeNull()
    // Decorated verdict lines still read as a verdict.
    expect(screen.getByText('Changes requested')).toBeInTheDocument()
    expect(screen.getByTestId('state-dot')).toHaveAttribute('data-state', 'done')
    expect(screen.queryByTestId('live-pane')).toBeNull()
  })

  it('says a verdict is missing, and lists the files a builder changed', () => {
    const report = {
      subject: 'Done',
      body: 'Looked fine.',
      outcome: 'succeeded' as const,
      filesModified: ['src/search.tsx'],
      reportPath: null,
      reportedAt: '2026-09-21T12:00:00Z'
    }
    render(
      <BuildReviewWorkerCard worker={worker({ role: 'reviewer', status: 'succeeded', report })} />
    )
    expect(screen.getByText('Verdict missing')).toBeInTheDocument()
    cleanup()
    render(<BuildReviewWorkerCard worker={worker({ status: 'succeeded', report })} />)
    expect(screen.getByText('src/search.tsx')).toBeInTheDocument()
    expect(screen.getByText('Succeeded')).toBeInTheDocument()
  })
})

it('draws a reviewer that has not started as one waiting row', () => {
  render(
    <BuildReviewWaitingRow
      worker={worker({ role: 'reviewer', status: 'pending', terminalHandle: null })}
      title="Reviewer 2"
    />
  )
  const row = document.querySelector('[data-build-review-waiting]')
  expect(row).toHaveTextContent('Reviewer 2')
  expect(row).toHaveTextContent('codex · gpt-5.5 · high')
  expect(row).toHaveTextContent('Waiting')
  expect(screen.queryByRole('button', { name: 'Open terminal' })).toBeNull()
})

it('says a reviewer did not run once the run stopped before its turn', () => {
  render(
    <BuildReviewWaitingRow
      worker={worker({ role: 'reviewer', status: 'pending', terminalHandle: null })}
      title="Reviewer 2"
      waiting={false}
    />
  )
  const row = document.querySelector('[data-build-review-waiting="not-run"]')
  expect(row).toHaveTextContent('Did not run')
  expect(row).not.toHaveTextContent('Waiting')
})

describe('BuildReviewWorkerCard startup blockers', () => {
  it("names Claude's folder-trust question and keeps its terminal one click away", async () => {
    mocks.focus.mockReturnValue(false)
    render(
      <BuildReviewWorkerCard
        worker={worker({
          choice: { agent: 'claude' },
          status: 'failed',
          error: 'agent_prompt_stalled',
          startupBlocker: 'claude-folder-trust',
          dispatchId: 'ctx_0123456789ab'
        })}
      />
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Claude is asking whether to trust this folder — open the terminal to answer.'
    )
    expect(screen.getByRole('alert')).not.toHaveTextContent('agent_prompt_stalled')
    expect(screen.getByText(/close that terminal and choose Retry/)).toBeInTheDocument()
    // The raw code and id stay available, folded away under Details.
    const details = document.querySelector('[data-build-review-details]')!
    expect(details).not.toHaveAttribute('open')
    expect(details).toHaveTextContent('agent_prompt_stalled')
    expect(details).toHaveTextContent('ctx_0123456789ab')
    const open = screen.getByRole('button', { name: 'Open terminal' })
    expect(open).toBeEnabled()
    fireEvent.click(open)
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith({ kind: 'local' }, 'terminal.focus', {
        terminal: 'term_builder',
        navigation: 'host'
      })
    )
  })

  it("says so plainly when the worker's terminal has been closed since", async () => {
    mocks.focus.mockReturnValue(false)
    mocks.rpc.mockRejectedValueOnce(new Error('terminal_handle_stale'))
    render(
      <BuildReviewWorkerCard
        worker={worker({
          status: 'failed',
          error: 'Agent startup blocked: codex-hooks-review-prompt',
          startupBlocker: 'codex-hooks-review-prompt'
        })}
      />
    )
    expect(screen.getAllByRole('alert')[0]).toHaveTextContent(
      'Codex found new or changed hooks and wants you to review them'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }))
    expect(await screen.findByText('That terminal is closed.')).toBeInTheDocument()
  })

  it('waits on the person while the run is still going, instead of asking for a Retry', () => {
    render(
      <BuildReviewWorkerCard
        live
        worker={worker({
          choice: { agent: 'claude' },
          status: 'starting',
          startupBlocker: 'claude-folder-trust'
        })}
      />
    )
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getAllByRole('status')[0]).toHaveTextContent(
      'Claude is asking whether to trust this folder — open the terminal to answer.'
    )
    expect(
      screen.getByText('The run goes on by itself once you have answered it.')
    ).toBeInTheDocument()
    expect(screen.queryByText(/choose Retry/)).toBeNull()
    expect(screen.getByTestId('state-dot')).toHaveAttribute('data-state', 'blocked')
    expect(screen.getByRole('button', { name: 'Show live terminal' })).toBeEnabled()
  })

  it('stops offering a terminal it found closed, and keeps that off the next attempt', async () => {
    mocks.focus.mockReturnValue(false)
    mocks.rpc.mockRejectedValueOnce(new Error('terminal_handle_stale'))
    const { rerender } = render(
      <BuildReviewWorkerCard
        live
        worker={worker({
          status: 'failed',
          error: 'worker stopped without reporting',
          dispatchId: 'ctx_old',
          terminalHandle: 'term_old'
        })}
      />
    )
    const open = screen.getByRole('button', { name: 'Open terminal' })
    fireEvent.click(open)
    expect(await screen.findByText('That terminal is closed.')).toBeInTheDocument()
    // Another click cannot open it.
    expect(open).toBeDisabled()
    // Retry: a new start in a new terminal, waiting on the person.
    rerender(
      <BuildReviewWorkerCard
        live
        worker={worker({
          status: 'starting',
          startupBlocker: 'codex-hooks-review-prompt',
          dispatchId: 'ctx_new',
          terminalHandle: 'term_new'
        })}
      />
    )
    expect(screen.getByRole('button', { name: 'Show live terminal' })).toBeEnabled()
    expect(screen.queryByText('That terminal is closed.')).toBeNull()
  })

  it('offers no way into a terminal that is known closed', () => {
    render(
      <BuildReviewWorkerCard
        worker={worker({
          status: 'failed',
          error: 'Agent startup blocked: codex-hooks-review-prompt',
          startupBlocker: 'codex-hooks-review-prompt',
          terminalClosed: true
        })}
      />
    )
    expect(screen.queryByRole('button', { name: 'Open terminal' })).toBeNull()
    expect(screen.getByText('Its terminal is closed.')).toBeInTheDocument()
  })

  it('words a failure without a blocker and leaves the internal ids out of it', () => {
    render(
      <BuildReviewWorkerCard
        worker={worker({
          status: 'failed',
          error: 'worker ctx_0123456789ab stopped without reporting'
        })}
      />
    )
    expect(screen.getByRole('alert')).toHaveTextContent('worker stopped without reporting')
    expect(screen.getByRole('alert')).not.toHaveTextContent('ctx_0123456789ab')
  })
})
