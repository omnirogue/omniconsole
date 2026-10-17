// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { EMPTY_AGENT_PANE_SNAPSHOT } from './agent-pane-snapshot'
import {
  ATTENTION_FIXTURE_LEAF_A,
  ATTENTION_FIXTURE_PANE_A,
  attentionFixturePane,
  attentionFixtureTab,
  attentionFixtureWorktree
} from './attention-test-fixtures'
import { ATTENTION_CURRENT_SLOT_ID, ATTENTION_NEEDS_YOU_SLOT_ID } from './attention-slot'

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  snapshot: null as unknown,
  portals: vi.fn(),
  backgroundMount: vi.fn(),
  openInWorkspace: vi.fn(),
  setActiveView: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.state)
}))
vi.mock('./use-agent-pane-snapshot', () => ({ useAgentPaneSnapshot: () => mocks.snapshot }))
vi.mock('../activity/activity-terminal-portal', () => ({
  setActivityTerminalPortals: mocks.portals
}))
vi.mock('../terminal/background-terminal-worktree-mount', () => ({
  requestBackgroundTerminalWorktreeMount: mocks.backgroundMount
}))
vi.mock('./attention-actions', () => ({ openAttentionPaneInWorkspace: mocks.openInWorkspace }))
// Why: these slot tests cover portals and stepping; the launch strip, the chat switch and the
// next-step button read detection, settings, tab and session state that have their own tests.
vi.mock('../next-action/UpNextControls', () => ({ UpNextControls: () => null }))
vi.mock('../next-action/UpNextPopover', () => ({ UpNextPopover: () => null }))
vi.mock('../sidebar/session-folders/use-sidebar-sessions', () => ({ useSidebarSessions: () => [] }))
vi.mock('@/lib/session-chain-registry', () => ({ useSessionChainForRow: () => null }))
vi.mock('@/store/wait-later-store', () => ({
  useWaitingKeys: () => new Set<string>(),
  useFinishedMarks: () => new Map<string, number>()
}))
vi.mock('./AttentionLaunchBar', () => ({
  AttentionLaunchBar: ({ worktreeId }: { worktreeId: string | null }) => (
    <div data-attention-launch-bar={worktreeId ?? ''} />
  )
}))
vi.mock('../native-chat/NativeChatViewSwitch', () => ({ NativeChatViewSwitch: () => null }))
import AttentionPage from './AttentionPage'

function baseState(): Record<string, unknown> {
  return {
    agentStatusByPaneKey: {},
    activeWorktreeId: 'w1',
    activeTabId: 'tab-a',
    activeTabType: 'terminal',
    tabsByWorktree: { w1: [attentionFixtureTab('tab-a', 'w1', 'pty-a')] },
    terminalLayoutsByTabId: {
      'tab-a': {
        root: { type: 'leaf', leafId: ATTENTION_FIXTURE_LEAF_A },
        activeLeafId: ATTENTION_FIXTURE_LEAF_A,
        expandedLeafId: null
      }
    },
    repos: [{ id: 'r1', displayName: 'Repo One', executionHostId: 'local' }],
    worktreesByRepo: { r1: [attentionFixtureWorktree('w1', 'wt-one')] },
    folderWorkspaces: [],
    projectGroups: [],
    sshConnectionStates: new Map(),
    runtimeStatusByEnvironmentId: new Map(),
    setActiveView: mocks.setActiveView
  }
}

function lastPortals(): { slotId: string; paneKey: string; active: boolean; tabId: string }[] {
  return (mocks.portals.mock.calls.at(-1)?.[0] ?? []) as never
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.state = baseState()
  mocks.snapshot = EMPTY_AGENT_PANE_SNAPSHOT
})

afterEach(cleanup)

describe('AttentionPage', () => {
  it('portals the current terminal and leaves the second screen blank when nothing waits', () => {
    render(
      <TooltipProvider>
        <AttentionPage />
      </TooltipProvider>
    )
    expect(screen.getByText('Nothing needs you')).toBeTruthy()
    expect(document.querySelector('[data-attention-launch-bar="w1"]')).not.toBeNull()
    const needsYou = screen.getByRole('region', { name: 'Needs you' })
    expect(needsYou.hasAttribute('data-attention-slot-empty')).toBe(true)
    expect(lastPortals()).toEqual([
      expect.objectContaining({
        slotId: ATTENTION_CURRENT_SLOT_ID,
        tabId: 'tab-a',
        paneKey: ATTENTION_FIXTURE_PANE_A,
        active: true
      })
    ])
    expect(mocks.backgroundMount).not.toHaveBeenCalled()
  })

  it('shows the oldest waiting pane, cycles with Next, and mounts its workspace in the background', async () => {
    const user = userEvent.setup()
    const older = attentionFixturePane({ title: 'Pick a deploy target' })
    const newer = attentionFixturePane({
      paneKey: 'tab-c:33333333-3333-4333-8333-333333333333',
      portalPaneKey: 'tab-c:33333333-3333-4333-8333-333333333333',
      tabId: 'tab-c',
      worktreeId: 'w3',
      title: 'Approve the migration',
      stateChangedAt: older.stateChangedAt + 1_000
    })
    mocks.snapshot = { ...EMPTY_AGENT_PANE_SNAPSHOT, attention: [older, newer] }
    render(
      <TooltipProvider>
        <AttentionPage />
      </TooltipProvider>
    )
    expect(screen.getByText('2 need you')).toBeTruthy()
    expect(screen.getByText('Pick a deploy target')).toBeTruthy()
    expect(screen.getByText('1 of 2')).toBeTruthy()
    expect(lastPortals()).toEqual([
      expect.objectContaining({ slotId: ATTENTION_CURRENT_SLOT_ID, active: true }),
      expect.objectContaining({
        slotId: ATTENTION_NEEDS_YOU_SLOT_ID,
        tabId: 'tab-b',
        paneKey: older.portalPaneKey,
        active: false
      })
    ])
    expect(mocks.backgroundMount).toHaveBeenCalledWith({ worktreeId: 'w2', tabIds: ['tab-b'] })

    await user.click(screen.getByRole('button', { name: 'Next pane that needs you' }))
    expect(screen.getByText('Approve the migration')).toBeTruthy()
    expect(screen.getByText('2 of 2')).toBeTruthy()
    expect(lastPortals()[1]).toMatchObject({ tabId: 'tab-c' })

    await user.click(screen.getByRole('button', { name: 'Open in workspace' }))
    expect(mocks.openInWorkspace).toHaveBeenCalledWith(expect.objectContaining({ tabId: 'tab-c' }))
  })

  it('keeps a pane the user is in after it stops waiting, and lets focus move the active flag', () => {
    const pane = attentionFixturePane()
    mocks.snapshot = { ...EMPTY_AGENT_PANE_SNAPSHOT, attention: [pane] }
    const view = render(
      <TooltipProvider>
        <AttentionPage />
      </TooltipProvider>
    )
    const needsYou = screen.getByRole('region', { name: 'Needs you' })
    fireEvent.pointerDown(needsYou)
    expect(lastPortals()).toEqual([
      expect.objectContaining({ slotId: ATTENTION_CURRENT_SLOT_ID, active: false }),
      expect.objectContaining({ slotId: ATTENTION_NEEDS_YOU_SLOT_ID, active: true })
    ])

    mocks.snapshot = EMPTY_AGENT_PANE_SNAPSHOT
    view.rerender(
      <TooltipProvider>
        <AttentionPage />
      </TooltipProvider>
    )
    expect(screen.getByText(/Done — clears when you leave this pane/)).toBeTruthy()
    expect(lastPortals()[1]).toMatchObject({ slotId: ATTENTION_NEEDS_YOU_SLOT_ID })

    fireEvent.pointerDown(screen.getByRole('region', { name: 'Working on' }))
    expect(
      screen.getByRole('region', { name: 'Needs you' }).hasAttribute('data-attention-slot-empty')
    ).toBe(true)
    expect(lastPortals()).toHaveLength(1)
  })

  it("shows a run's request as its ask, with the why and the way to meet it", () => {
    const why = "claude's provider rejected its sign-in, and only you hold those credentials."
    const asked = attentionFixturePane({
      title: 'Ship the landing page',
      // Why: the pane's own prompt text is not what the run asks for.
      askSummary: 'Press enter to continue',
      run: {
        chainId: 'chain',
        sourceRowKey: 'row',
        headline: 'Needs you: Sign claude in again.',
        why,
        requests: [
          {
            id: 'att_provider-authentication_outcome_1',
            kind: 'credential',
            scope: { outcomeId: 'outcome', outcomeRevision: 1 },
            ask: 'Sign claude in again.',
            why,
            recipient: { type: 'owner' },
            action: { kind: 'sign-in', label: 'Sign in' },
            source: { type: 'provider-authentication', ref: 'claude' },
            state: 'open',
            openedAt: 5
          }
        ]
      }
    })
    mocks.snapshot = { ...EMPTY_AGENT_PANE_SNAPSHOT, attention: [asked] }
    render(
      <TooltipProvider>
        <AttentionPage />
      </TooltipProvider>
    )
    expect(screen.getByText('1 need you')).toBeTruthy()
    expect(document.querySelector('[data-attention-ask="request"]')!.textContent).toBe(
      'Needs you: Sign claude in again.'
    )
    expect(document.querySelector('[data-attention-why]')!.textContent).toBe(why)
    expect(screen.queryByText('Press enter to continue')).toBeNull()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy()
    // Why: showing the request is not meeting it; nothing here marks it seen or resolved.
    expect(mocks.openInWorkspace).not.toHaveBeenCalled()
  })

  it('explains a non-terminal active tab and offers the workspace view', async () => {
    const user = userEvent.setup()
    mocks.state = { ...baseState(), activeTabType: 'editor' }
    render(
      <TooltipProvider>
        <AttentionPage />
      </TooltipProvider>
    )
    expect(screen.getByText('The active tab is not a terminal.')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Show it in the workspace' }))
    expect(mocks.setActiveView).toHaveBeenCalledWith('terminal')
    expect(lastPortals()).toEqual([])
  })

  it('clears every portal when the page unmounts', () => {
    const view = render(
      <TooltipProvider>
        <AttentionPage />
      </TooltipProvider>
    )
    expect(lastPortals()).toHaveLength(1)
    view.unmount()
    expect(lastPortals()).toEqual([])
  })
})
