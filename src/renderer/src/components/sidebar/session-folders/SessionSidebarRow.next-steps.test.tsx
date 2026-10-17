// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { emptySessionFolderMetadata } from '@/lib/session-folders'
import { emptySessionSidebarView } from '@/lib/session-sidebar-view'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { usePendingNextSteps } from '@/components/next-steps/next-steps-pending-store'
import { SessionSidebarRow } from './SessionSidebarRow'

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/components/next-step/add-next/AddNextPanels', () => ({ AddNextPanels: () => null }))
vi.mock('./SessionRowHoverCard', () => ({
  SessionRowHoverCard: ({ children }: { children: React.ReactNode }) => children
}))

const session: SidebarSession = {
  rowKey: 'row-1',
  sessionKey: 'session-1',
  worktreeId: 'repo:/workspace',
  hostId: 'local',
  tabId: 'term:tab-1',
  paneKey: 'term:tab-1:pane-1',
  kind: 'terminal',
  label: 'Build landing page',
  workspaceLabel: 'Website',
  agent: 'codex',
  unavailable: false,
  folderKeyMigration: null
}

beforeEach(() => {
  useSessionSidebarView.setState({
    view: { ...emptySessionSidebarView(), density: 'comfortable' },
    archived: [],
    loaded: true,
    showHidden: false
  })
  useSessionFolders.setState({ metadata: emptySessionFolderMetadata(), loaded: true, error: null })
  usePendingNextSteps.setState({ counts: new Map(), revision: null, unknown: false })
  mocks.rpc.mockResolvedValue({
    sets: [
      {
        id: 'ai-1',
        conversation: { worktreeId: session.worktreeId, paneKey: session.paneKey, kind: 'pty' },
        worktreeId: session.worktreeId,
        turnKey: 't1',
        origin: 'ai',
        createdAt: 1,
        status: 'pending',
        suggestions: ['Run the tests', 'Open a PR', 'Update docs'].map((title, index) => ({
          id: `a${index}`,
          title,
          prompt: title,
          risk: 'safe',
          kind: 'continue'
        }))
      }
    ],
    skips: [],
    revision: 1
  })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('shows the real badge with the pending count on the row and opens the conversation', async () => {
  const onOpen = vi.fn()
  render(
    <TooltipProvider>
      <SessionSidebarRow
        session={session}
        current={false}
        queued={false}
        onOpen={onOpen}
        onCancelQueue={vi.fn()}
      />
    </TooltipProvider>
  )
  const badge = await screen.findByRole('button', {
    name: '3 suggested next steps in Build landing page'
  })
  expect(badge.textContent).toBe('✦3')
  expect(mocks.rpc).toHaveBeenCalledWith({ kind: 'local' }, 'nextSteps.list', {
    statuses: ['pending']
  })
  fireEvent.click(badge)
  expect(onOpen).toHaveBeenCalledTimes(1)
})
