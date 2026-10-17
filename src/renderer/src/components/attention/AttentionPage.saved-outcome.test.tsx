// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Children, cloneElement, createContext, useContext, useMemo } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { savedOutcomeSourceFixture } from '@/lib/sidebar-outcome-source-test-fixtures'
import {
  clearSessionChainEntries,
  publishSessionChains,
  setSessionChainEntry
} from '@/lib/session-chain-registry'
import { EMPTY_AGENT_PANE_SNAPSHOT } from './agent-pane-snapshot'

const mocks = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.state),
    {
      getState: () => mocks.state
    }
  )
}))
vi.mock('./use-agent-pane-snapshot', () => ({
  useAgentPaneSnapshot: () => EMPTY_AGENT_PANE_SNAPSHOT
}))
vi.mock('../activity/activity-terminal-portal', () => ({ setActivityTerminalPortals: vi.fn() }))
vi.mock('../terminal/background-terminal-worktree-mount', () => ({
  requestBackgroundTerminalWorktreeMount: vi.fn()
}))
vi.mock('./attention-actions', () => ({ openAttentionPaneInWorkspace: vi.fn() }))
vi.mock('./AttentionLaunchBar', () => ({ AttentionLaunchBar: () => null }))
vi.mock('../native-chat/NativeChatViewSwitch', () => ({ NativeChatViewSwitch: () => null }))
vi.mock('../next-step/SessionChainStatus', () => ({ SessionChainStatus: () => null }))
vi.mock('../tasks/CreateTaskButton', () => ({ CreateTaskButton: () => null }))
vi.mock('../next-action/UpNextChain', () => ({ UpNextChain: () => null }))
vi.mock('../next-action/SessionDetails', () => ({ SessionDetails: () => null }))
vi.mock('../next-action/use-session-details-facts', () => ({
  // Why: the connected details decide whether Files has a viewer from these facts, so the stub
  // carries the session and an empty More even though `SessionDetails` itself is mocked away.
  // The facts line above the chain (brief 78 #3) reads the agent, location, workspace and task.
  useSessionDetailsFacts: () => ({
    session: { worktreeId: 'folder:1' },
    agent: { name: 'Claude', state: 'idle', detail: null },
    runsOn: 'This device',
    workspace: 'Workspace',
    task: null,
    more: { files: { count: 0 } }
  })
}))
// This suite now covers the composer's own Outcome head (`OutcomeLine`) behind the "Up next"
// popover trigger, in place of the retired `NextStepOutcomeDialog`. Real Radix popover
// positioning is not available in happy-dom, so — matching this repo's existing pattern
// (`ArtifactPublishButton.test.tsx`) — the popover primitives are replaced with a thin,
// context-backed stand-in that keeps the trigger's own open/close contract (`aria-expanded`,
// click-to-open composed with the trigger child's own onClick, content only in the DOM while
// open) without needing real floating-ui positioning.
const PopoverOpenCtx = createContext<{ open: boolean; onOpenChange?: (open: boolean) => void }>({
  open: false
})

function MockPopover({
  children,
  open,
  onOpenChange
}: {
  children: ReactNode
  open: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const value = useMemo(() => ({ open, onOpenChange }), [open, onOpenChange])
  return <PopoverOpenCtx.Provider value={value}>{children}</PopoverOpenCtx.Provider>
}

function MockPopoverTrigger({ children }: { children: ReactNode }) {
  const { open, onOpenChange } = useContext(PopoverOpenCtx)
  const only = Children.only(children) as ReactElement<{
    onClick?: (event: unknown) => void
    'aria-expanded'?: boolean
    'aria-haspopup'?: string
  }>
  return cloneElement(only, {
    'aria-expanded': open,
    'aria-haspopup': 'dialog',
    onClick: (event: unknown) => {
      only.props.onClick?.(event)
      onOpenChange?.(!open)
    }
  })
}

function MockPopoverContent({ children }: { children: ReactNode }) {
  const { open } = useContext(PopoverOpenCtx)
  return open ? <div data-up-next-popover-content>{children}</div> : null
}

vi.mock('@/components/ui/popover', () => ({
  Popover: MockPopover,
  PopoverTrigger: MockPopoverTrigger,
  PopoverAnchor: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: MockPopoverContent
}))
import AttentionPage from './AttentionPage'

afterEach(() => {
  cleanup()
  clearSessionChainEntries()
  publishSessionChains()
})

function popoverContent(): HTMLElement | null {
  return document.querySelector('[data-up-next-popover-content]')
}

it('keeps the Up next composer open when the current provider exits to its shell', () => {
  const { source, tab, chain } = savedOutcomeSourceFixture()
  mocks.state = {
    ...source,
    activeWorktreeId: tab.worktreeId,
    activeTabId: tab.id,
    activeTabType: 'terminal',
    setActiveView: vi.fn()
  }
  setSessionChainEntry(chain)
  publishSessionChains()
  const page = () => (
    <TooltipProvider>
      <AttentionPage />
    </TooltipProvider>
  )
  const view = render(page())
  fireEvent.click(screen.getByRole('button', { name: 'Up next' }))
  expect(screen.getByRole('button', { name: 'Up next' }).getAttribute('aria-expanded')).toBe('true')
  expect(within(popoverContent()!).getByText('Saved recovery result')).toBeTruthy()

  mocks.state = {
    ...mocks.state,
    tabsByWorktree: {
      [tab.worktreeId]: [{ ...tab, launchAgent: undefined, title: 'Terminal 2' }]
    }
  }
  view.rerender(page())
  // The provider exited (launchAgent gone) but the durable outcome still owns the pane, so
  // the session — and the open composer over it — survive the rerender untouched.
  expect(screen.getByRole('button', { name: 'Up next' }).getAttribute('aria-expanded')).toBe('true')
  expect(within(popoverContent()!).getByText('Saved recovery result')).toBeTruthy()
  expect(screen.getByText('Terminal 2')).toBeTruthy()
  expect(screen.queryByText('Codex')).toBeNull()

  // Removing the durable obligation with no provider left to own the pane drops the session —
  // and with it the composer — entirely: the chain registry is an independent subscription,
  // so this must happen even though no app-store field changes.
  act(() => {
    clearSessionChainEntries()
    publishSessionChains()
  })
  expect(screen.queryByRole('button', { name: 'Up next' })).toBeNull()
  expect(popoverContent()).toBeNull()
})

it('shows the saved outcome when a durable chain arrives for a shell already on screen', () => {
  const { source, tab, chain } = savedOutcomeSourceFixture()
  delete tab.launchAgent
  mocks.state = {
    ...source,
    activeWorktreeId: tab.worktreeId,
    activeTabId: tab.id,
    activeTabType: 'terminal',
    setActiveView: vi.fn()
  }
  render(
    <TooltipProvider>
      <AttentionPage />
    </TooltipProvider>
  )
  // No provider and no durable outcome yet: the pane has no session, so no composer renders.
  expect(screen.queryByRole('button', { name: 'Up next' })).toBeNull()
  act(() => {
    setSessionChainEntry(chain)
    publishSessionChains()
  })
  fireEvent.click(screen.getByRole('button', { name: 'Up next' }))
  expect(within(popoverContent()!).getByText('Saved recovery result')).toBeTruthy()
})
