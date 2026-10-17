// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { emptySessionFolderMetadata } from '@/lib/session-folders'
import { emptySessionSidebarView } from '@/lib/session-sidebar-view'
import { useAppStore } from '@/store'
import { useSessionFolders } from '@/store/session-folders'
import {
  clearSessionChainEntries,
  publishSessionChains,
  setSessionChainEntry
} from '@/lib/session-chain-registry'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import type { SessionChain } from '../../../../../shared/session-chain-types'
import { SessionSidebarRow } from './SessionSidebarRow'
import { useSessionRowHosts } from './use-session-row-host-label'
import { useSessionHistoryOpen } from '@/store/session-history-open'

// These cover the hand composer itself, which ships behind a flag that is off.
vi.mock('@/components/next-action/up-next-composer-flag', () => ({
  UP_NEXT_COMPOSER_ENABLED: true
}))

vi.mock('@/components/next-step/add-next/AddNextPanels', () => ({
  AddNextPanels: () => <div role="menu">Legacy recipient menu</div>
}))
// Why: clicks hover the row, and the card's 500 ms open timer outlived the test environment.
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

function renderRow(overrides: Partial<ComponentProps<typeof SessionSidebarRow>> = {}) {
  const props: ComponentProps<typeof SessionSidebarRow> = {
    session,
    current: false,
    queued: false,
    onOpen: vi.fn(),
    onCancelQueue: vi.fn(),
    ...overrides
  }
  render(
    <TooltipProvider>
      <SessionSidebarRow {...props} />
    </TooltipProvider>
  )
  return props
}

beforeEach(() => {
  useSessionSidebarView.setState({
    // Why comfortable: these tests read the agent and status lines on the row itself; the
    // default compact row keeps them for its hover card (see SessionSidebarRow.compact.test).
    view: { ...emptySessionSidebarView(), density: 'comfortable' },
    archived: [],
    loaded: true,
    showHidden: false
  })
  useSessionFolders.setState({ metadata: emptySessionFolderMetadata(), loaded: true, error: null })
})

afterEach(() => {
  cleanup()
  clearSessionChainEntries()
  publishSessionChains()
})

describe('SessionSidebarRow add next action', () => {
  it('shows the lineage badge after the session title changes', () => {
    renderRow({ subagent: true, session: { ...session, label: 'Renamed by provider' } })

    expect(screen.getByText('SUB')).toBeTruthy()
    expect(screen.getByTitle('Subagent')).toBeTruthy()
    expect(screen.getByText('Renamed by provider')).toBeTruthy()
  })

  it('does not add a lineage badge to an ordinary conversation titled SUB', () => {
    renderRow({ session: { ...session, label: 'SUB · regular conversation' } })

    expect(screen.queryByText('SUB', { exact: true })).toBeNull()
    expect(screen.getByText('SUB · regular conversation')).toBeTruthy()
  })

  it('keeps technical details alongside the same quick actions', () => {
    renderRow({ technical: true })
    expect(screen.getByText('codex · This device · Website')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Up next' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Dispatch Build landing page/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'More options' })).toBeTruthy()
  })

  it('opens the durable outcome editor from the plus action', async () => {
    const user = userEvent.setup()
    renderRow()

    await user.click(screen.getByRole('button', { name: 'Up next' }))

    expect(screen.getByRole('heading', { name: 'Up next' })).toBeTruthy()
  })

  it('More options opens the composer', async () => {
    const user = userEvent.setup()
    renderRow()

    await user.click(screen.getByRole('button', { name: 'More options' }))
    const dispatch = screen.getByRole('menuitem', {
      name: 'Up next'
    })
    await user.click(dispatch)

    expect(screen.getByRole('heading', { name: 'Up next' })).toBeTruthy()
    // Session details fold to one facts line (brief 78 #3); Runs on is one disclosure away.
    await user.click(screen.getByRole('button', { name: /^Details/ }))
    expect(screen.getByRole('button', { name: 'Runs on' })).toBeTruthy()
  })

  it('shows and cancels an existing queued successor', async () => {
    const user = userEvent.setup()
    const props = renderRow({ queued: true })

    expect(screen.getByText('Next session queued')).toBeTruthy()
    await user.click(
      screen.getByRole('button', { name: 'Cancel queued session after Build landing page' })
    )

    expect(props.onCancelQueue).toHaveBeenCalledOnce()
  })

  it('keeps a failed queue on the row with its reason until it is dismissed', async () => {
    const user = userEvent.setup()
    const props = renderRow({
      queued: true,
      chain: {
        chainId: 'chn_1',
        rowKey: session.rowKey,
        queued: 2,
        total: 3,
        state: 'failed',
        auto: false,
        destination: { kind: 'me' },
        blocked: null,
        launchedPaneKeys: [],
        error:
          "The next session's agent exited before it started working (zsh is in the foreground)."
      }
    })

    // Why: the row keeps one clipped line; the whole explanation waits in the details block.
    // A failed queue is an honest failure: it reads Failed, and it never lights the row up.
    expect(screen.getByText(/^Failed · The next agent could not begin work/)).toBeTruthy()
    expect(document.querySelector('[data-session-status="failed"]')).toBeTruthy()
    expect(document.querySelector('[data-needs-attention]')).toBeNull()
    expect(screen.queryByText('2 sessions queued')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Show details for Build landing page' }))
    expect(screen.getByText(/could not begin work\. Check the selected agent/)).toBeTruthy()
    await user.click(
      screen.getByRole('button', { name: 'Dismiss the failed queue after Build landing page' })
    )

    expect(props.onCancelQueue).toHaveBeenCalledOnce()
  })

  it('explains a persisted connection failure without claiming the agent stopped', () => {
    renderRow({
      queued: true,
      chain: {
        chainId: 'chn_1',
        rowKey: session.rowKey,
        queued: 1,
        total: 1,
        state: 'failed',
        auto: false,
        destination: { kind: 'me' },
        blocked: null,
        launchedPaneKeys: [],
        error: "Error invoking remote method 'terminal:wait': Error: terminal_gone"
      }
    })

    expect(
      screen.getByText(/The connection to this conversation is no longer available/)
    ).toBeTruthy()
    expect(screen.queryByText(/terminal_gone/)).toBeNull()
    expect(screen.queryByText(/agent stopped/)).toBeNull()
  })

  it('shows the agent state and a waiting highlight when the pane needs the user', () => {
    renderRow({
      state: 'waiting',
      attention: {
        paneKey: session.paneKey!,
        portalPaneKey: session.paneKey,
        worktreeId: session.worktreeId,
        tabId: session.tabId!,
        leafId: 'pane-1',
        agentType: 'codex',
        bucket: 'attention',
        dotState: 'waiting',
        cause: 'waiting',
        unseen: true,
        title: 'Build landing page',
        stateChangedAt: 1,
        repoName: 'Website',
        worktreeName: 'main'
      }
    })
    const row = screen.getByRole('button', {
      name: 'Open session Build landing page'
    }).parentElement!
    expect(row.hasAttribute('data-needs-attention')).toBe(true)
    expect(screen.getByText('Waiting for your input')).toBeTruthy()
    // Why: the row's glyph is the conversation state, explained on hover.
    expect(screen.getByLabelText('Needs you — waiting for your answer or approval.')).toBeTruthy()
  })

  it('replaces ＋ and 🚀 with a lock and where the work goes once a next step is set', () => {
    const plan = (
      destination: { kind: 'done' } | { kind: 'me' } | { kind: 'person'; names: string }
    ) => ({
      chainId: 'c',
      rowKey: 'row-1',
      queued: 1,
      total: 1,
      state: 'waiting' as const,
      auto: false,
      destination,
      blocked: null,
      launchedPaneKeys: [],
      error: null,
      summary: 'Current → Claude → End session'
    })
    renderRow({ queued: true, chain: plan({ kind: 'done' }) })
    expect(screen.queryByRole('button', { name: /Define.*finish/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Up next' })).toBeNull()
    const ends = screen.getByRole('img', {
      name: 'Next step is set · the session ends when it finishes successfully'
    })
    expect(ends.getAttribute('data-session-plan-lock')).toBe('done')
    // Why: a green check says the session ends; the lock alone says only that a plan is set.
    expect(ends.querySelectorAll('svg')).toHaveLength(2)
    expect(ends.querySelector('svg.text-emerald-500')).toBeTruthy()

    cleanup()
    renderRow({ queued: true, chain: plan({ kind: 'person', names: 'Uma' }) })
    expect(
      screen
        .getByRole('img', { name: 'Next step is set · then goes to Uma' })
        .getAttribute('data-session-plan-lock')
    ).toBe('person')

    cleanup()
    renderRow({ queued: true, chain: plan({ kind: 'me' }) })
    expect(
      screen.getByRole('img', { name: 'Next step is set · then comes back to you' })
    ).toBeTruthy()
  })

  it('keeps a completed outcome set editable and does not expose the legacy cancellation', () => {
    setSessionChainEntry({
      id: 'chn_outcome',
      workspacePath: '/workspace',
      worktreeId: session.worktreeId,
      hostId: 'local',
      sourcePaneKey: session.paneKey!,
      sourceRowKey: session.rowKey,
      auto: true,
      end: 'done',
      steps: [],
      currentIndex: 0,
      state: 'done',
      createdAt: 1,
      updatedAt: 1,
      outcomeSet: {
        schemaVersion: 1,
        revision: 1,
        outcomes: [],
        removals: [],
        attempts: [],
        continuation: {
          owner: 'execution-host',
          hostId: 'local',
          epoch: 'epoch_1',
          state: 'owned'
        },
        updatedAt: 1
      } as never
    } as SessionChain)
    publishSessionChains()
    const props = renderRow({
      queued: true,
      chain: {
        chainId: 'chn_outcome',
        rowKey: session.rowKey,
        queued: 0,
        total: 0,
        state: 'done',
        auto: true,
        destination: { kind: 'done' },
        blocked: null,
        launchedPaneKeys: [],
        error: null
      }
    })

    expect(screen.getByRole('button', { name: 'Up next' })).toBeTruthy()
    expect(
      screen.queryByRole('button', { name: 'Cancel queued session after Build landing page' })
    ).toBeNull()
    expect(props.onCancelQueue).not.toHaveBeenCalled()
  })

  it('locks a session a plan launched, since that plan already chose what comes next', () => {
    setSessionChainEntry({
      id: 'chn_source',
      workspacePath: '/workspace',
      worktreeId: session.worktreeId,
      hostId: 'local',
      sourcePaneKey: 'term:tab-0:pane-0',
      sourceRowKey: 'row-0',
      auto: true,
      end: 'done',
      steps: [
        {
          id: 'step_1',
          agent: 'claude',
          prompt: 'Improve',
          status: 'launched',
          launchedPaneKey: session.paneKey
        }
      ],
      currentIndex: 1,
      state: 'waiting',
      createdAt: 1,
      updatedAt: 1
    } as SessionChain)
    publishSessionChains()
    renderRow()
    expect(screen.queryByRole('button', { name: /Define.*finish/ })).toBeNull()
    expect(
      screen
        .getByRole('img', {
          name: 'Next step is set · the session ends when it finishes successfully'
        })
        .getAttribute('data-session-plan-lock')
    ).toBe('done')
    // Why: only the row the plan was set on can cancel it.
    expect(
      screen.queryByRole('button', { name: 'Cancel the plan after Build landing page' })
    ).toBeNull()
  })

  it('puts a plan that is waiting on the person under Needs you and says what carries on', () => {
    renderRow({
      queued: true,
      planNeedsYou: true,
      chain: {
        chainId: 'c',
        rowKey: 'row-1',
        queued: 0,
        total: 0,
        state: 'waiting',
        auto: true,
        destination: { kind: 'done' },
        blocked: { paneKey: session.paneKey!, reason: 'waiting' },
        launchedPaneKeys: [],
        error: null
      }
    })
    const row = screen.getByRole('button', {
      name: 'Open session Build landing page'
    }).parentElement!
    expect(row.hasAttribute('data-needs-attention')).toBe(true)
    expect(screen.getByText('Needs your answer · the plan carries on after')).toBeTruthy()
    // Why: nothing is queued after a plan that only ends the session.
    expect(screen.queryByText('Next session queued')).toBeNull()
    expect(screen.getByLabelText('Needs you — waiting for your answer or approval.')).toBeTruthy()
    // Why: the plan is still set; only the person can unblock it, so the lock stays.
    expect(
      screen.getByRole('img', {
        name: 'Next step is set · the session ends when it finishes successfully'
      })
    ).toBeTruthy()
  })

  it('offers to cancel a live plan from the row', async () => {
    const user = userEvent.setup()
    const props = renderRow({
      queued: true,
      chain: {
        chainId: 'c',
        rowKey: 'row-1',
        queued: 1,
        total: 1,
        state: 'waiting',
        auto: false,
        destination: { kind: 'me' },
        blocked: null,
        launchedPaneKeys: [],
        error: null,
        summary: 'Current → Claude → Done'
      }
    })

    await user.click(
      screen.getByRole('button', { name: 'Cancel the plan after Build landing page' })
    )

    expect(props.onCancelQueue).toHaveBeenCalledOnce()
  })

  it('keeps the add action present but refuses it without a live execution workspace', () => {
    renderRow({ session: { ...session, paneKey: null } })
    const withoutPane = screen.getByRole('button', { name: 'Up next' })
    expect(withoutPane.hasAttribute('disabled')).toBe(true)
    expect(withoutPane.getAttribute('title')).toBe(
      'There is no live session here to continue. Open it first, then add what comes next.'
    )

    cleanup()
    renderRow({ session: { ...session, unavailable: true } })
    const unavailable = screen.getByRole('button', { name: 'Up next' })
    expect(unavailable.hasAttribute('disabled')).toBe(true)
    expect(unavailable.getAttribute('title')).toBe(
      'This conversation is unverifiable right now. Reconnect to its computer and try again.'
    )
  })

  it('says the ask once when the row itself is asking and its plan is parked on it', () => {
    renderRow({
      queued: true,
      planNeedsYou: true,
      attention: {
        paneKey: session.paneKey!,
        portalPaneKey: session.paneKey,
        worktreeId: session.worktreeId,
        tabId: session.tabId!,
        leafId: 'pane-1',
        agentType: 'codex',
        bucket: 'attention',
        dotState: 'waiting',
        cause: 'waiting',
        unseen: true,
        title: 'Build landing page',
        stateChangedAt: 1,
        repoName: 'Website',
        worktreeName: 'main'
      },
      chain: {
        chainId: 'c',
        rowKey: 'row-1',
        queued: 1,
        total: 1,
        state: 'waiting',
        auto: false,
        destination: { kind: 'me' },
        blocked: { paneKey: session.paneKey!, reason: 'waiting' },
        launchedPaneKeys: [],
        error: null
      }
    })
    expect(screen.getByText('Needs your answer · the plan carries on after')).toBeTruthy()
    expect(screen.queryByText('Waiting for your input')).toBeNull()
    expect(screen.queryByText('Next session queued')).toBeNull()
  })
})

describe('SessionSidebarRow rename in place', () => {
  const nameField = () => screen.getByRole('textbox', { name: 'Rename Build landing page' })

  it.each(['toggle', 'range'])(
    'keeps a %s gesture on the revealed pencil selecting the row',
    (gesture) => {
      const props = renderRow({ onRename: vi.fn(), onSelect: vi.fn(() => true) })
      fireEvent.click(screen.getByRole('button', { name: 'Rename Build landing page' }), {
        shiftKey: gesture === 'range',
        metaKey: gesture === 'toggle' && navigator.userAgent.includes('Mac'),
        ctrlKey: gesture === 'toggle' && !navigator.userAgent.includes('Mac')
      })
      expect(props.onSelect).toHaveBeenCalledOnce()
      expect(screen.queryByRole('textbox')).toBeNull()
      expect(props.onRename).not.toHaveBeenCalled()
      expect(props.onOpen).not.toHaveBeenCalled()
    }
  )

  it('opens a field from the pencil; Enter saves without opening the session', async () => {
    const user = userEvent.setup()
    const props = renderRow({ onRename: vi.fn() })
    await user.click(screen.getByRole('button', { name: 'Rename Build landing page' }))
    const field = nameField() as HTMLInputElement
    expect(document.activeElement).toBe(field)
    expect(field.selectionStart).toBe(0)
    expect(field.selectionEnd).toBe('Build landing page'.length)
    expect(screen.queryByRole('button', { name: 'Open session Build landing page' })).toBeNull()
    await user.keyboard('Launch plan{Enter}')
    expect(props.onRename).toHaveBeenCalledExactlyOnceWith('Launch plan')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByRole('button', { name: 'Open session Build landing page' })).toBeTruthy()
    expect(props.onOpen).not.toHaveBeenCalled()
  })

  it('cancels on Escape, writes nothing when unchanged, and clears to the generated name', async () => {
    const user = userEvent.setup()
    const props = renderRow({ onRename: vi.fn() })
    const pencil = () => screen.getByRole('button', { name: 'Rename Build landing page' })
    await user.click(pencil())
    await user.keyboard('Something else{Escape}')
    expect(screen.queryByRole('textbox')).toBeNull()
    await user.click(pencil())
    await user.keyboard('{Enter}')
    expect(props.onRename).not.toHaveBeenCalled()
    await user.click(pencil())
    await user.clear(nameField())
    await user.keyboard('{Enter}')
    expect(props.onRename).toHaveBeenCalledExactlyOnceWith(null)
  })

  it('saves once when focus leaves the field', async () => {
    const user = userEvent.setup()
    const props = renderRow({ onRename: vi.fn() })
    await user.click(screen.getByRole('button', { name: 'Rename Build landing page' }))
    await user.keyboard('Pricing review')
    await user.click(document.body)
    expect(props.onRename).toHaveBeenCalledExactlyOnceWith('Pricing review')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('starts from F2 on the focused row and stops the row dragging while editing', async () => {
    const user = userEvent.setup()
    renderRow({ onRename: vi.fn(), onDragStart: vi.fn() })
    const open = screen.getByRole('button', { name: 'Open session Build landing page' })
    expect(open.parentElement!.getAttribute('draggable')).toBe('true')
    open.focus()
    await user.keyboard('{F2}')
    expect(document.activeElement).toBe(nameField())
    expect(document.querySelector('[data-session-row]')!.getAttribute('draggable')).toBeNull()
  })

  it('offers no pencil when the row cannot be renamed or its computer is unreachable', () => {
    renderRow()
    expect(screen.queryByRole('button', { name: 'Rename Build landing page' })).toBeNull()
    cleanup()
    renderRow({ onRename: vi.fn(), session: { ...session, unavailable: true } })
    expect(screen.queryByRole('button', { name: 'Rename Build landing page' })).toBeNull()
  })
})

describe('SessionSidebarRow quick actions', () => {
  const SAVED_FOLDER = '11111111-1111-4111-8111-111111111111'

  it('keeps the idle cluster in order: hide, archive, tags, more, next', () => {
    // Why Tags last: the put-away group folds away from its end, widest first.
    renderRow()
    expect(
      screen.getAllByRole('button').map((button) => button.getAttribute('aria-label'))
    ).toEqual([
      'Open session Build landing page',
      'Hide Build landing page',
      'Archive Build landing page',
      'Tags',
      'More options',
      'Up next'
    ])
    expect(screen.queryByRole('button', { name: 'Organize conversation' })).toBeNull()
    expect(document.querySelector('[data-conversation-color]')).toBeNull()
    expect(document.querySelector('[data-session-row]')!.getAttribute('style')).toBeNull()
  })

  it('archives from the hover cluster and unarchives only a hand-archived row', async () => {
    const user = userEvent.setup()
    renderRow()
    await user.click(screen.getByRole('button', { name: 'Archive Build landing page' }))
    expect(useSessionSidebarView.getState().archived).toEqual(['session-1'])
    expect(screen.queryByRole('menu')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Unarchive Build landing page' }))
    expect(useSessionSidebarView.getState().archived).toEqual([])
    expect(screen.getByRole('button', { name: 'Archive Build landing page' })).toBeTruthy()

    cleanup()
    // Why: a row that aged into Archived was never put away by hand, so there is nothing to undo.
    renderRow({ archived: true })
    expect(screen.queryByRole('button', { name: /archive Build landing page/i })).toBeNull()
    expect(screen.getByRole('button', { name: 'Hide Build landing page' })).toBeTruthy()
    // Why: like the Mac's Trash, deleting happens from Archived — and only there.
    expect(screen.getByRole('button', { name: 'Delete Build landing page' })).toBeTruthy()
    cleanup()
    renderRow()
    expect(screen.queryByRole('button', { name: 'Delete Build landing page' })).toBeNull()
  })

  it('archives a saved row in one click and still offers Remove from Saved Sessions', async () => {
    const user = userEvent.setup()
    useSessionFolders.setState({
      metadata: {
        version: 1,
        folders: [{ id: SAVED_FOLDER, name: 'Keep', section: 'saved' }],
        membership: { 'session-1': SAVED_FOLDER }
      },
      loaded: true,
      error: null
    })
    renderRow()
    expect(screen.getByRole('button', { name: 'Archive Build landing page' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'More options' }))
    const menu = screen.getByRole('menu')
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.getAttribute('aria-label') ?? item.textContent)
    ).toEqual(['Up next', 'Remove from Saved Sessions', 'Close conversation', 'History'])
    await user.click(within(menu).getByRole('menuitem', { name: 'Remove from Saved Sessions' }))
    expect(useSessionFolders.getState().metadata.membership['session-1']).toBeUndefined()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('keeps More options to the composer on an ordinary row', async () => {
    const user = userEvent.setup()
    renderRow()
    await user.click(screen.getByRole('button', { name: 'More options' }))
    expect(
      within(screen.getByRole('menu'))
        .getAllByRole('menuitem')
        .map((item) => item.getAttribute('aria-label'))
    ).toEqual(['Up next', 'Close conversation', 'History'])
  })

  it('opens the row’s History from the menu, even on a row with no other details', async () => {
    const user = userEvent.setup()
    renderRow()
    expect(document.querySelector('[data-session-history]')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'More options' }))
    await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'History' }))
    expect(document.querySelector('[data-session-history="open"]')).not.toBeNull()
    useSessionHistoryOpen.setState({ open: new Set() })
  })
})

describe('SessionSidebarRow computer name on a comfortable row', () => {
  const STUDIO_ID = '7f3c2a9e-1b4d-4c6e-9a8f-2d5b6c7e8f90'
  const onStudio: SidebarSession = { ...session, hostId: `runtime:${STUDIO_ID}` }
  const environmentsBefore = useAppStore.getState().runtimeEnvironments
  const label = () => document.querySelector('[data-session-host-label]')

  beforeEach(() => {
    useAppStore.setState({ runtimeEnvironments: [{ id: STUDIO_ID, name: 'Mac Studio' }] as never })
    useSessionRowHosts.setState({ shown: true })
  })

  afterEach(() => {
    useAppStore.setState({ runtimeEnvironments: environmentsBefore })
    useSessionRowHosts.setState({ shown: false })
  })

  it('names the computer on the title line, above the agent line', () => {
    renderRow({ session: onStudio })
    expect(label()!.textContent).toBe('Mac Studio')
    expect(label()!.parentElement!.textContent).toBe('Build landing pageMac Studio')
    expect(document.querySelector('[data-session-agent-line]')!.textContent).toBe('codex')
    expect(
      screen.getByRole('button', { name: 'Open session Build landing page on Mac Studio' })
    ).toBeTruthy()
  })

  it('leaves a technical row to its detail line, which already names the host', () => {
    renderRow({ session: onStudio, technical: true })
    expect(label()).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Open session Build landing page on Mac Studio' })
    ).toBeTruthy()
  })
})
