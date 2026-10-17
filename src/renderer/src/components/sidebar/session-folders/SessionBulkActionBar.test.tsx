// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmationDialogProvider } from '@/components/confirmation-dialog'
import { TooltipProvider } from '@/components/ui/tooltip'
import { emptySessionFolderMetadata } from '@/lib/session-folders'
import { emptySessionSidebarView } from '@/lib/session-sidebar-view'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { ConversationFleetView } from '@/store/conversation-fleet-store'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { SessionBulkActionBar } from './SessionBulkActionBar'

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  closeTerminalTab: vi.fn(),
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), message: vi.fn() }
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.state),
    { getState: () => mocks.state }
  )
}))
vi.mock('@/components/terminal/terminal-tab-actions', () => ({
  closeTerminalTab: mocks.closeTerminalTab
}))
vi.mock('@/components/next-action/UpNextSubject', () => ({
  UpNextSubject: ({
    subject,
    onChanged
  }: {
    subject: { session: SidebarSession }
    onChanged: () => void
  }) => (
    <>
      <span data-testid="dispatch-subject">{subject.session.sessionKey}</span>
      <button type="button" onClick={onChanged}>
        Send now
      </button>
    </>
  )
}))
vi.mock('./SessionBulkFleetDispatch', () => ({
  SessionBulkFleetDispatch: ({
    items,
    onFinished
  }: {
    items: { key: string; label: string }[]
    onFinished: (outcomes: { key: string; label: string; ok: boolean; message?: string }[]) => void
  }) => (
    <div>
      <span>One batch configuration for {items.length}</span>
      <button
        type="button"
        onClick={() =>
          onFinished([
            { key: items[0].key, label: items[0].label, ok: true },
            { key: items[1].key, label: items[1].label, ok: true },
            { key: items[2].key, label: items[2].label, ok: false, message: 'not confirmed' }
          ])
        }
      >
        Dispatch batch once
      </button>
    </div>
  )
}))
vi.mock('sonner', () => ({ toast: mocks.toast }))

function session(id: string, overrides: Partial<SidebarSession> = {}): SidebarSession {
  return {
    rowKey: `row-${id}`,
    sessionKey: `session-${id}`,
    worktreeId: 'repo:/workspace',
    hostId: 'local',
    tabId: `tab-${id}`,
    paneKey: `tab-${id}:pane`,
    kind: 'terminal',
    label: `Conversation ${id}`,
    workspaceLabel: 'Website',
    agent: 'codex',
    unavailable: false,
    folderKeyMigration: null,
    ...overrides
  }
}

const FOLDER = '00000000-0000-4000-8000-000000000001'

function renderBar(
  sessions: SidebarSession[],
  overrides: Partial<Parameters<typeof SessionBulkActionBar>[0]> = {}
) {
  const props = {
    sessions,
    folders: useSessionFolders.getState().metadata.folders,
    queuedRowKeys: new Set<string>(),
    onCreateFolder: vi.fn((name: string) => useSessionFolders.getState().createFolder(name)),
    onClear: vi.fn(),
    onCompleted: vi.fn(),
    ...overrides
  }
  render(
    <TooltipProvider>
      <ConfirmationDialogProvider>
        <SessionBulkActionBar {...props} />
      </ConfirmationDialogProvider>
    </TooltipProvider>
  )
  return props
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  mocks.state = {
    agentStatusByPaneKey: {},
    setContextualToursBlockingSurfaceVisible: vi.fn(),
    // Why: a delete plans the tab's PTY retirement from the store before the (mocked) close, so
    // the plan's fields must exist; with no live tabs here the plan is empty and nothing is ended.
    repos: [],
    worktreesByRepo: {},
    tabsByWorktree: {},
    unifiedTabsByWorktree: {},
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {},
    lastKnownRelayPtyIdByTabId: {},
    deferredSshSessionIdsByTabId: {},
    pendingReconnectPtyIdByTabId: {}
  }
  useSessionFolders.setState({
    loaded: true,
    error: null,
    metadata: { ...emptySessionFolderMetadata(), folders: [{ id: FOLDER, name: 'Later' }] }
  })
  useSessionSidebarView.setState({
    view: emptySessionSidebarView(),
    archived: [],
    loaded: true,
    showHidden: false
  })
  mocks.closeTerminalTab.mockImplementation((_tabId: string, options?: { onClosed?: () => void }) =>
    options?.onClosed?.()
  )
})

afterEach(cleanup)

describe('SessionBulkActionBar', () => {
  it('shows the count and each action with its eligible count', () => {
    const view = useSessionSidebarView.getState()
    view.setHiddenMany(['conversation:session-a'], true)
    view.setArchived(['session-b'], true)
    renderBar([session('a'), session('b'), session('c', { sessionKey: null, tabId: null })])
    expect(screen.getByRole('toolbar', { name: 'Selected conversations' })).toBeTruthy()
    expect(screen.getByText('3 selected')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Archive (2)' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Hide (2)' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Move to folder (2)' })).toBeTruthy()
    // Why 3: a closed, hidden or archived conversation deletes too, not only one with an open tab.
    expect(screen.getByRole('button', { name: 'Delete (3)' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /snooze|^wait$/i })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Dispatch (3)' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Send to human (3)' })).toBeTruthy()
  })

  it('disables an action with nothing eligible', () => {
    useSessionSidebarView.getState().setArchived(['session-a'], true)
    renderBar([session('a')])
    expect(
      (screen.getByRole('button', { name: 'Archive (0)' }) as HTMLButtonElement).disabled
    ).toBe(true)
  })

  it('hides the eligible rows in one save and clears them from the selection', async () => {
    const user = userEvent.setup()
    const props = renderBar([session('a'), session('b')])
    const before = useSessionSidebarView.getState().view
    await user.click(screen.getByRole('button', { name: 'Hide (2)' }))
    const after = useSessionSidebarView.getState().view
    expect(after).not.toBe(before)
    expect(after.hidden).toEqual(['conversation:session-a', 'conversation:session-b'])
    expect(props.onCompleted).toHaveBeenCalledWith(['session-a', 'session-b'])
    expect(mocks.toast.success).toHaveBeenCalledWith('Hidden: 2 conversations.', undefined)
  })

  it('archives and hides receipts from other computers, through the source when it is reachable', async () => {
    const user = userEvent.setup()
    const sourced = session('c', { hostId: 'ssh:mw0002' as SidebarSession['hostId'] })
    const run = (id: string, sessionKey: string | null) =>
      ({
        workflowId: `wf_${id}`,
        rowKey: `row-${id}`,
        sessionKey,
        title: `Remote ${id}`,
        machine: 'mw0002',
        jobs: [],
        admission: 'accepted',
        verified: true,
        error: null
      }) as unknown as ConversationFleetView
    const props = renderBar([session('a')], {
      fleetRows: [
        { run: run('c', sourced.sessionKey), source: sourced },
        { run: run('gone', null), source: null }
      ]
    })
    expect(screen.getByText('3 selected')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Move to folder (2)' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Delete (3)' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Hide (3)' }))
    expect(useSessionSidebarView.getState().view.hidden).toEqual([
      'conversation:session-a',
      'conversation:session-c',
      'conversation:row-gone'
    ])
    expect(props.onCompleted).toHaveBeenCalledWith(['session-a', 'session-c', 'row-gone'])
    await user.click(screen.getByRole('button', { name: 'Archive (3)' }))
    expect(useSessionSidebarView.getState().archived).toEqual([
      'session-a',
      'session-c',
      'row-gone'
    ])
  })

  it('archives by hand so the rows sit under Archived regardless of age', async () => {
    const user = userEvent.setup()
    const props = renderBar([session('a'), session('b')])
    await user.click(screen.getByRole('button', { name: 'Archive (2)' }))
    expect(useSessionSidebarView.getState().archived).toEqual(['session-a', 'session-b'])
    expect(props.onCompleted).toHaveBeenCalledWith(['session-a', 'session-b'])
    expect(mocks.toast.success).toHaveBeenCalledWith('Archived: 2 conversations.', undefined)
  })

  // E1/F13 (session parity, Phase 1b): a row a paired owner's ledger created runs there, so no bulk
  // action touches it here; a live mirror row the ledger joined stays in every action as before.
  it('leaves a ledger-only row out of every bulk action and keeps a joined mirror row in', async () => {
    const user = userEvent.setup()
    const mirrored = {
      environmentId: 'env-studio',
      conversation: '0123456789abcdef01234567',
      ownerPaneKey: null,
      ownerTabId: null,
      rest: 'asleep' as const,
      listed: true,
      stale: false,
      ownerState: 'ready' as const
    }
    const ledgerKey = JSON.stringify([
      'runtime:env-studio',
      'ledger',
      'repo:/workspace',
      'c:0123456789abcdef01234567'
    ])
    const ledgerOnly = session('l', {
      rowKey: ledgerKey,
      sessionKey: ledgerKey,
      hostId: 'runtime:env-studio',
      tabId: null,
      paneKey: null,
      mirroredConversation: mirrored
    })
    const joined = session('j', {
      hostId: 'runtime:env-studio',
      mirroredConversation: { ...mirrored, rest: 'live' }
    })
    const props = renderBar([session('a'), ledgerOnly, joined])
    expect(screen.getByText('3 selected')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('owning computer')
    for (const name of ['Archive (2)', 'Hide (2)', 'Move to folder (2)', 'Delete (2)']) {
      expect(screen.getByRole('button', { name })).toBeTruthy()
    }
    await user.click(screen.getByRole('button', { name: 'Move to folder (2)' }))
    await user.click(screen.getByRole('menuitem', { name: 'Later' }))
    expect(useSessionFolders.getState().metadata.membership).toEqual({
      'session-a': FOLDER,
      'session-j': FOLDER
    })
    expect(props.onCompleted).toHaveBeenLastCalledWith(['session-a', 'session-j'])
  })

  it('moves the selection into an existing folder, back to Unfiled, or a new folder', async () => {
    const user = userEvent.setup()
    const props = renderBar([session('a'), session('b'), session('c', { sessionKey: null })])
    await user.click(screen.getByRole('button', { name: 'Move to folder (2)' }))
    await user.click(screen.getByRole('menuitem', { name: 'Later' }))
    expect(useSessionFolders.getState().metadata.membership).toEqual({
      'session-a': FOLDER,
      'session-b': FOLDER
    })
    expect(props.onCompleted).toHaveBeenLastCalledWith(['session-a', 'session-b'])

    await user.click(screen.getByRole('button', { name: 'Move to folder (2)' }))
    await user.click(screen.getByRole('menuitem', { name: 'Unfiled' }))
    expect(useSessionFolders.getState().metadata.membership).toEqual({})

    await user.click(screen.getByRole('button', { name: 'Create Folder' }))
    await user.type(screen.getByRole('textbox', { name: 'New folder' }), 'Planning')
    await user.keyboard('{Enter}')
    const planning = useSessionFolders
      .getState()
      .metadata.folders.find((f) => f.name === 'Planning')
    expect(planning).toBeTruthy()
    expect(useSessionFolders.getState().metadata.membership).toEqual({
      'session-a': planning!.id,
      'session-b': planning!.id
    })
    expect(mocks.toast.success).toHaveBeenCalledTimes(3)
  })

  it('deletes every selected conversation in one click: open tabs close, all rows leave', async () => {
    const user = userEvent.setup()
    const closed = session('c', { sessionKey: null, tabId: null })
    const props = renderBar([session('a'), closed])
    await user.click(screen.getByRole('button', { name: 'Delete (2)' }))
    await vi.waitFor(() => expect(props.onCompleted).toHaveBeenCalled())
    expect(screen.queryByText('Stop and delete?')).toBeNull()
    expect(mocks.closeTerminalTab.mock.calls.map((call) => call[0])).toEqual(['tab-a'])
    expect(mocks.closeTerminalTab.mock.calls[0][1]).toMatchObject({
      reason: 'user',
      captureRecentlyClosed: true
    })
    expect(useSessionSidebarView.getState().view.deleted).toEqual(['session-a', 'row-c'])
    expect(props.onCompleted).toHaveBeenCalledWith(['session-a', 'row-c'])
    expect(mocks.toast.success).toHaveBeenCalledWith(
      'Deleted 2 conversations',
      expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) })
    )
  })

  it('asks once only when a selected conversation is still working', async () => {
    const user = userEvent.setup()
    mocks.state = {
      ...mocks.state,
      agentStatusByPaneKey: { 'tab-b:pane': { state: 'working' } }
    }
    const props = renderBar([session('a'), session('b')])
    await user.click(screen.getByRole('button', { name: 'Delete (2)' }))
    expect(await screen.findByText('Stop and delete?')).toBeTruthy()
    expect(mocks.closeTerminalTab).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Stop and delete' }))
    await vi.waitFor(() => expect(props.onCompleted).toHaveBeenCalled())
    expect(mocks.closeTerminalTab.mock.calls.map((call) => call[0])).toEqual(['tab-a', 'tab-b'])
  })

  it('keeps a refused tab selected and reports only the row actually deleted', async () => {
    const user = userEvent.setup()
    mocks.closeTerminalTab.mockImplementation((_id: string, options: { onCancel: () => void }) =>
      options.onCancel()
    )
    const props = renderBar([session('a'), session('b', { tabId: null })])
    await user.click(screen.getByRole('button', { name: 'Delete (2)' }))
    await vi.waitFor(() => expect(props.onCompleted).toHaveBeenCalledWith(['session-b']))
    expect(useSessionSidebarView.getState().view.deleted).toEqual(['session-b'])
    expect(mocks.toast.warning).toHaveBeenCalledWith('Deleted Conversation b', expect.any(Object))
  })

  it('removes fleet receipts and paused routines together with archived conversations', async () => {
    const user = userEvent.setup()
    const props = renderBar([session('a', { tabId: null })], {
      fleetRows: [
        {
          run: {
            workflowId: 'wf_cleanup',
            rowKey: 'receipt-cleanup',
            title: 'Fleet receipt'
          } as ConversationFleetView,
          source: null
        }
      ],
      routines: [
        { key: 'routine:local:paused', automation: { name: 'Paused routine', enabled: false } }
      ] as unknown as NonNullable<Parameters<typeof SessionBulkActionBar>[0]['routines']>
    })
    await user.click(screen.getByRole('button', { name: 'Delete (3)' }))
    await vi.waitFor(() => expect(props.onCompleted).toHaveBeenCalled())
    expect(useSessionSidebarView.getState().view.deleted).toHaveLength(3)
    expect(useSessionSidebarView.getState().view.deleted).toContain('routine:local:paused')
    expect(mocks.toast.success).toHaveBeenCalledWith('Deleted 3 conversations', expect.any(Object))
  })

  it('deletes nothing when the working prompt is declined', async () => {
    const user = userEvent.setup()
    mocks.state = {
      ...mocks.state,
      agentStatusByPaneKey: { 'tab-a:pane': { state: 'working' } }
    }
    const props = renderBar([session('a')])
    await user.click(screen.getByRole('button', { name: 'Delete (1)' }))
    await user.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(props.onCompleted).not.toHaveBeenCalled()
    expect(mocks.closeTerminalTab).not.toHaveBeenCalled()
    expect(useSessionSidebarView.getState().view.deleted).toBeUndefined()
  })

  it('keeps a tab that starts working while a routine pause is pending', async () => {
    const user = userEvent.setup()
    let finishPause!: (ok: boolean) => void
    const setEnabled = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishPause = resolve
        })
    )
    const props = renderBar([session('a'), session('b', { tabId: null })], {
      routines: [
        { key: 'routine:local:pending', automation: { name: 'Routine', enabled: true } }
      ] as unknown as NonNullable<Parameters<typeof SessionBulkActionBar>[0]['routines']>,
      routineCommands: { setEnabled }
    })
    await user.click(screen.getByRole('button', { name: 'Delete (3)' }))
    await vi.waitFor(() => expect(setEnabled).toHaveBeenCalled())
    expect(mocks.closeTerminalTab).not.toHaveBeenCalled()
    mocks.state = { ...mocks.state, agentStatusByPaneKey: { 'tab-a:pane': { state: 'working' } } }
    finishPause(true)
    await vi.waitFor(() =>
      expect(props.onCompleted).toHaveBeenCalledWith(['session-b', 'routine:local:pending'])
    )
    expect(mocks.closeTerminalTab).not.toHaveBeenCalled()
    expect(useSessionSidebarView.getState().view.deleted).toEqual([
      'session-b',
      'routine:local:pending'
    ])
    expect(mocks.toast.warning).toHaveBeenCalledWith('Deleted 2 conversations', expect.any(Object))
  })

  it('opens one batch Dispatch form and summarizes acknowledged receipts', async () => {
    const user = userEvent.setup()
    const props = renderBar([session('a'), session('b'), session('c')])
    await user.click(screen.getByRole('button', { name: 'More options' }))
    await user.click(screen.getByRole('button', { name: 'Dispatch (3)' }))
    expect(screen.getByText('One batch configuration for 3')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Dispatch batch once' }))
    expect(props.onCompleted).toHaveBeenCalledWith(['session-a', 'session-b'])
    expect(mocks.toast.warning).toHaveBeenCalledWith('Dispatched: 2 of 3.', {
      description: 'Not done: Conversation c (not confirmed)'
    })
    expect(screen.queryByRole('button', { name: 'Dispatch (3)' })).toBeNull()
  })

  it('keeps human handoff as a per-conversation flow', async () => {
    const user = userEvent.setup()
    const props = renderBar([session('a'), session('b')])
    await user.click(screen.getByRole('button', { name: 'Send to human (2)' }))
    expect(screen.getByText('1 of 2 · Conversation a')).toBeTruthy()
    expect(screen.getByTestId('dispatch-subject').textContent).toBe('session-a')
    await user.click(screen.getByRole('button', { name: 'Send now' }))
    expect(screen.getByText('2 of 2 · Conversation b')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Send now' }))
    expect(props.onCompleted).toHaveBeenCalledWith(['session-a', 'session-b'])
  })
})
