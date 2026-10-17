// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { workflowView } from '../local-workflows/local-workflow-ui.fixtures'
import type { WorkflowResults } from './workflow-results-candidates'
import { WorkflowResultsLaunchDialog } from './WorkflowResultsLaunchDialog'

const mocks = vi.hoisted(() => ({
  detect: vi.fn(async () => ['claude', 'codex']),
  launch: vi.fn(async () => true),
  activate: vi.fn(),
  state: {
    settings: { defaultTuiAgent: 'codex', disabledTuiAgents: [] },
    getKnownWorktreeById: (id: string) => (id === 'wt-1' ? { path: '/work/shop' } : undefined),
    unifiedTabsByWorktree: { 'wt-1': [{ id: 'unified-1', entityId: 'tab-1', groupId: 'group-1' }] },
    activeGroupIdByWorktree: {},
    groupsByWorktree: {}
  }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, values?: Record<string, string | number>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(values?.[key] ?? ''))
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    { getState: () => mocks.state }
  )
}))
vi.mock('@/lib/launch-agent-session-continuation', () => ({
  detectAgentSessionContinuationAgents: mocks.detect,
  launchAgentSessionContinuation: mocks.launch
}))
vi.mock('@/lib/activate-tab-and-focus-pane', () => ({ activateTabAndFocusPane: mocks.activate }))
vi.mock('@/lib/agent-catalog', () => ({
  getAgentCatalog: () => [
    { id: 'claude', label: 'Claude' },
    { id: 'codex', label: 'Codex' }
  ]
}))
vi.mock('@/components/agent/AgentCombobox', () => ({
  default: ({ value }: { value: string | null }) => <div data-testid="agent">{value}</div>
}))
vi.mock('@/components/build-review/BuildReviewAgentFields', () => ({
  BuildReviewModelEffortFields: () => null
}))
vi.mock('@/components/agent/AgentAccountSelect', () => ({ AgentAccountSelect: () => null }))
vi.mock('@/components/ui/dialog', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>
  return {
    Dialog: Pass,
    DialogContent: Pass,
    DialogDescription: Pass,
    DialogFooter: Pass,
    DialogHeader: Pass,
    DialogTitle: Pass
  }
})

const RESULTS: WorkflowResults = {
  kind: 'discover',
  candidates: [
    {
      id: 'run-1:a',
      key: 'a',
      title: 'Retry drops the idempotency key',
      detail: 'A retry charges the card twice.',
      location: 'src/pay.ts:142',
      tally: 'confirmed',
      preselected: true
    }
  ]
}

function open(onClose = vi.fn()) {
  render(
    <WorkflowResultsLaunchDialog
      target={{ worktreeId: 'wt-1', tabId: 'tab-1' }}
      view={{ ...workflowView(), executionId: 'run-1', state: 'completed' }}
      results={RESULTS}
      chosen={RESULTS.candidates}
      onClose={onClose}
    />
  )
  return onClose
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.state.settings = { defaultTuiAgent: 'codex', disabledTuiAgents: [] }
})
afterEach(cleanup)

describe('WorkflowResultsLaunchDialog', () => {
  it('starts the default agent with the findings and the usual instruction, sent', async () => {
    const onClose = open()
    await waitFor(() => expect(screen.getByTestId('agent')).toHaveTextContent('codex'))
    expect(screen.getByLabelText('What should it do?')).toHaveValue(
      'Fix the findings above. Re-check each one first; skip any that does not hold up and say why. Run the relevant tests.'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Start session' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    const [args] = mocks.launch.mock.calls[0]! as unknown as [Record<string, unknown>]
    expect(args).toMatchObject({
      agent: 'codex',
      worktreeId: 'wt-1',
      groupId: 'group-1',
      workspacePath: '/work/shop',
      launchSource: 'workflow_follow_up'
    })
    expect(args.promptDelivery).toBeUndefined()
    expect(args.prompt).toContain('### 1. Retry drops the idempotency key')
    expect(String(args.prompt)).toMatch(/\n\nInstruction:\nFix the findings above\. Re-check/)
  })

  it('leaves the results in the session composer, unsent, when the instruction is left to the session', async () => {
    open()
    await waitFor(() => expect(screen.getByTestId('agent')).toHaveTextContent('codex'))
    fireEvent.click(screen.getByRole('button', { name: 'Write it in the session' }))
    expect(screen.getByLabelText('What should it do?')).toHaveValue('')
    fireEvent.click(screen.getByRole('button', { name: 'Open session' }))
    await waitFor(() => expect(mocks.launch).toHaveBeenCalled())
    const [args] = mocks.launch.mock.calls[0]! as unknown as [Record<string, unknown>]
    expect(args).toMatchObject({ promptDelivery: 'draft', viewModePreference: 'terminal' })
    expect(String(args.prompt).endsWith('\n\nInstruction:')).toBe(true)
  })

  it('gives up an agent that settings disable, for one that is still enabled', async () => {
    const onClose = vi.fn()
    const props = {
      target: { worktreeId: 'wt-1', tabId: 'tab-1' },
      view: { ...workflowView(), executionId: 'run-1', state: 'completed' as const },
      results: RESULTS,
      chosen: RESULTS.candidates,
      onClose
    }
    const { rerender } = render(<WorkflowResultsLaunchDialog {...props} />)
    await waitFor(() => expect(screen.getByTestId('agent')).toHaveTextContent('codex'))
    mocks.state.settings = { defaultTuiAgent: 'codex', disabledTuiAgents: ['codex'] as never[] }
    rerender(<WorkflowResultsLaunchDialog {...props} />)
    await waitFor(() => expect(screen.getByTestId('agent')).toHaveTextContent('claude'))
    fireEvent.click(screen.getByRole('button', { name: 'Start session' }))
    await waitFor(() => expect(mocks.launch).toHaveBeenCalled())
    const [args] = mocks.launch.mock.calls[0]! as unknown as [Record<string, unknown>]
    expect(args).toMatchObject({ agent: 'claude' })
  })

  it('takes another ready instruction, and stays open when the session did not start', async () => {
    mocks.launch.mockResolvedValueOnce(false)
    const onClose = open()
    await waitFor(() => expect(screen.getByTestId('agent')).toHaveTextContent('codex'))
    fireEvent.click(screen.getByRole('button', { name: 'Plan the fixes' }))
    expect(screen.getByLabelText('What should it do?')).toHaveValue(
      'Plan how to fix the findings above, most severe first, without changing any code yet.'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Start session' }))
    await waitFor(() => expect(mocks.launch).toHaveBeenCalled())
    expect(onClose).not.toHaveBeenCalled()
  })
})
