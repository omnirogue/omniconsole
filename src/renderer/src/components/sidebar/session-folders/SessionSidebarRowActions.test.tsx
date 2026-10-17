// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { SessionChainRowInfo } from '@/lib/session-chain-runner'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { SessionSidebarRowActions } from './SessionSidebarRowActions'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'

// These cover the hand composer itself, which ships behind a flag that is off.
vi.mock('@/components/next-action/up-next-composer-flag', () => ({
  UP_NEXT_COMPOSER_ENABLED: true
}))

/**
 * Why this test exists: the ⋮ menu used to host the composer inside its own PopoverContent, so
 * nothing could close the menu — opening Up next left two popovers stacked and Escape dismissed
 * only the inner one. The composer is hoisted out of the menu; the menu closes when it opens.
 */
vi.mock('@/components/next-action/UpNextSubject', () => ({
  UpNextSubject: () => <div>Up next composer</div>
}))
vi.mock('@/components/next-action/UpNextControls', () => ({ UpNextControls: () => null }))
vi.mock('@/components/next-step/SessionPlanLock', () => ({ SessionPlanLock: () => null }))
vi.mock('@/lib/session-chain-registry', () => ({ useSessionChainForRow: () => null }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn() }))
vi.mock('@/lib/session-folders', () => ({
  getSessionFolderId: () => null,
  isSavedSessionFolder: () => false,
  SAVED_SESSIONS_FOLDER_ID: 'saved'
}))
vi.mock('@/store/session-folders', () => ({
  useSessionFolders: Object.assign((select: (value: unknown) => unknown) => select({}), {
    getState: () => ({ moveSession: vi.fn() })
  })
}))
vi.mock('@/store/session-sidebar-view', () => ({
  useSessionSidebarView: Object.assign((select: (value: unknown) => unknown) =>
    select({ archived: [] })
  )
}))
vi.mock('./PersonalHideButton', () => ({ PersonalHideButton: () => null }))
vi.mock('./ConversationArchiveButton', () => ({ ConversationArchiveButton: () => null }))
afterEach(cleanup)

const session = {
  rowKey: 'row',
  sessionKey: 'session',
  worktreeId: 'folder:1',
  hostId: 'local',
  tabId: 'tab',
  paneKey: 'tab:leaf',
  kind: 'terminal',
  label: 'Conversation',
  workspaceLabel: 'Workspace',
  agent: 'claude',
  unavailable: false,
  folderKeyMigration: null
} as SidebarSession

const READY_CHAIN: SessionChainRowInfo = {
  chainId: 'chn_1',
  rowKey: 'row',
  queued: 1,
  total: 2,
  state: 'ready',
  auto: false,
  error: null,
  destination: { kind: 'me' },
  blocked: null,
  launchedPaneKeys: []
}

function renderRow(
  queueRefusal: string | null = null,
  chain: SessionChainRowInfo | null = null,
  workerDispatchId?: string,
  workerProcessIncarnation?: string
) {
  return render(
    <TooltipProvider>
      <SessionSidebarRowActions
        session={session}
        workerDispatchId={workerDispatchId}
        workerProcessIncarnation={workerProcessIncarnation}
        chain={chain}
        queued={false}
        queueRefusal={queueRefusal}
        hidden={false}
        onToggleHidden={vi.fn()}
        onCancelQueue={vi.fn()}
        onStartChain={chain ? vi.fn() : undefined}
      />
    </TooltipProvider>
  )
}

it('offers exact-dispatch Keep as conversation only for a lineage-verified worker', () => {
  const { rerender } = renderRow()
  expect(screen.queryByRole('button', { name: 'Keep Conversation as a conversation' })).toBeNull()
  rerender(
    <TooltipProvider>
      <SessionSidebarRowActions
        session={session}
        workerDispatchId="dispatch-1"
        workerProcessIncarnation="proc-1"
        chain={null}
        queued={false}
        queueRefusal={null}
        hidden={false}
        onToggleHidden={vi.fn()}
        onCancelQueue={vi.fn()}
      />
    </TooltipProvider>
  )
  expect(screen.getByRole('button', { name: 'Keep Conversation as a conversation' })).toBeTruthy()
})

it('hides Keep when the process identity is missing from the current lineage proof', () => {
  renderRow(null, null, 'dispatch-1')
  expect(screen.queryByRole('button', { name: 'Keep Conversation as a conversation' })).toBeNull()
})

it('retains only the verified dispatch and refreshes the durable lineage projection', async () => {
  vi.mocked(callRuntimeRpc).mockResolvedValueOnce({
    dispatchId: 'dispatch-1',
    state: 'retained',
    reason: 'user_requested'
  })
  const refresh = vi.fn()
  window.addEventListener('omni.worker-lineage-refresh', refresh)
  renderRow(null, null, 'dispatch-1', 'proc-1')
  fireEvent.click(screen.getByRole('button', { name: 'Keep Conversation as a conversation' }))
  await vi.waitFor(() =>
    expect(callRuntimeRpc).toHaveBeenCalledWith({ kind: 'local' }, 'orchestration.workerRetain', {
      dispatch: 'dispatch-1',
      expectedPaneKey: session.paneKey,
      expectedProcessIncarnation: 'proc-1'
    })
  )
  await vi.waitFor(() =>
    expect(callRuntimeRpc).toHaveBeenCalledWith({ kind: 'local' }, 'orchestration.workerRetain', {
      dispatch: 'dispatch-1',
      expectedPaneKey: session.paneKey,
      expectedProcessIncarnation: 'proc-1'
    })
  )
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce())
  window.removeEventListener('omni.worker-lineage-refresh', refresh)
})

it("shows the row's Tags as an icon named Tags, and marks a ready plan's ▶ for the name's reserve", () => {
  renderRow(null, READY_CHAIN)
  // Why: labelled, Tags was the widest control and never fit beside the name's floor.
  const tags = screen.getByRole('button', { name: 'Tags' })
  expect(tags.textContent).toBe('')
  expect(tags.className.split(' ')).toContain('size-6')
  // Why: the name's floor leaves the ▶ its room, so the row's fixed controls never overflow it.
  const start = screen.getByRole('button', {
    name: 'Start the next queued session after Conversation'
  })
  expect(start.hasAttribute('data-session-row-start')).toBe(true)
})

it('closes the ⋮ menu when the composer opens, and keeps the composer', () => {
  renderRow()
  expect(screen.queryByText('Up next composer')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'More options' }))
  expect(screen.getByRole('menu')).toBeTruthy()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Up next' }))
  expect(screen.getByText('Up next composer')).toBeTruthy()
  // Why: two stacked popovers left the menu lingering until an outside click.
  expect(screen.queryByRole('menu')).toBeNull()
  expect(screen.queryByRole('menuitem', { name: 'Up next' })).toBeNull()
})

it('closes the composer on Escape, leaving no menu behind', () => {
  renderRow()
  fireEvent.click(screen.getByRole('button', { name: 'More options' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Up next' }))
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByText('Up next composer')).toBeNull()
  expect(screen.queryByRole('menu')).toBeNull()
})

it('refuses to open the composer while the queue refuses this row', () => {
  renderRow('This conversation cannot take a next step yet.')
  fireEvent.click(screen.getByRole('button', { name: 'More options' }))
  const item = screen.getByRole('menuitem', { name: 'Up next' }) as HTMLButtonElement
  expect(item.disabled).toBe(true)
  expect(item.title).toBe('This conversation cannot take a next step yet.')
  fireEvent.click(item)
  expect(screen.queryByText('Up next composer')).toBeNull()
})
