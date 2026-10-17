// @vitest-environment happy-dom
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { emptySessionFolderMetadata } from '@/lib/session-folders'
import { sessionLensGroupKey } from '@/lib/session-sidebar-lens'
import { emptySessionSidebarView, withSessionSidebarGroupBy } from '@/lib/session-sidebar-view'
import {
  buildSessionSidebarTree,
  type SessionSidebarGroup as GroupModel,
  type SessionSidebarTreeRow
} from '@/lib/session-sidebar-tree'
import { buildSidebarSessions, type SidebarSession } from '@/lib/sidebar-sessions'
import {
  conversationDigest,
  LEDGER_ENV,
  ledgerBucket,
  ledgerRecord,
  ledgerSlices,
  pairedSource,
  providerSession
} from '@/lib/mirrored-conversation-test-fixtures'
import {
  addSessionTestTab,
  SESSION_TEST_LEAF,
  SESSION_TEST_WORKTREE,
  sessionTestSource
} from '@/lib/sidebar-session-test-fixtures'
import { useAppStore } from '@/store'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { makePaneKey } from '../../../../../shared/stable-pane-id'
import type { SessionParityFields } from '../../../../../shared/session-parity'
import { SessionSidebarGroup } from './SessionSidebarGroup'
import { usePublishSessionGroupParity, useSessionGroupParity } from './session-group-parity'

vi.mock('@/components/next-step/add-next/AddNextPanels', () => ({
  AddNextPanels: () => <div role="menu">Legacy recipient menu</div>
}))

const STUDIO = `runtime:${LEDGER_ENV}` as const
const initialState = useAppStore.getInitialState()

function session(key: string): SidebarSession {
  return {
    rowKey: key,
    sessionKey: key,
    worktreeId: SESSION_TEST_WORKTREE,
    hostId: STUDIO,
    tabId: null,
    paneKey: null,
    kind: 'terminal',
    label: key,
    workspaceLabel: 'Website',
    agent: 'claude',
    unavailable: false,
    folderKeyMigration: null
  }
}

function treeRow(entry: SidebarSession, folderId: string | null = null): SessionSidebarTreeRow {
  return { session: entry, folderId, attention: null, state: null, waitingUntil: null }
}

function computerGroup(sessions: SidebarSession[]): GroupModel {
  return {
    key: sessionLensGroupKey('computer', STUDIO),
    kind: 'computer',
    label: 'Mac Studio',
    rows: sessions.map((entry) => treeRow(entry)),
    collapsed: true,
    hidden: false,
    attentionCount: 0,
    canReorder: false,
    canHide: false
  }
}

function renderGroup(model: GroupModel): void {
  render(
    <TooltipProvider>
      <SessionSidebarGroup
        group={model}
        folders={model.folder ? [model.folder] : []}
        activeTabId={null}
        activeWorktreeId={null}
        queuedRowKeys={new Set<string>()}
        onToggle={vi.fn()}
        onHide={vi.fn()}
        onMoveGroup={vi.fn()}
        onRenameFolder={vi.fn()}
        onDeleteFolder={vi.fn()}
        onOpen={vi.fn()}
        onMoveSessionKey={vi.fn()}
        onCancelQueue={vi.fn()}
      />
    </TooltipProvider>
  )
}

const fields = (
  bucket: SessionParityFields['bucket'],
  verification: SessionParityFields['verification'] = 'verified'
) => ({ bucket, verification })

const headline = () =>
  document.querySelector<HTMLElement>('[data-session-group-listed-count]')?.textContent
const onlyHere = () => document.querySelector<HTMLElement>('[data-session-group-only-here]')
const held = () => document.querySelector<HTMLElement>('[data-session-group-held]')

beforeEach(() => {
  useAppStore.setState(initialState, true)
  useSessionGroupParity.setState({ byRowKey: new Map() })
  useSessionSidebarView.setState({
    view: emptySessionSidebarView(),
    archived: [],
    loaded: true,
    showHidden: false
  })
  useSessionFolders.setState({ metadata: emptySessionFolderMetadata(), loaded: true, error: null })
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
})

describe('group heading counts (session parity, step 8)', () => {
  it('headlines the rows their owner lists, with "+N only here (can\'t verify)" apart', () => {
    const rows = ['listed-1', 'listed-2', 'flow', 'stray', 'kept'].map(session)
    useSessionGroupParity.setState({
      byRowKey: new Map([
        ['listed-1', fields('ownerListed')],
        ['listed-2', fields('ownerListed', 'stale')],
        ['flow', fields('workflow')],
        ['stray', fields('receiverOnly', 'unverified')],
        ['kept', fields('heldByOwner')]
      ])
    })
    renderGroup(computerGroup(rows))

    expect(headline()).toBe('3')
    expect(onlyHere()?.textContent).toBe("+1 only here (can't verify)")
    expect(onlyHere()?.dataset.sessionGroupOnlyHere).toBe('1')
    // A capture its owner holds without listing is no mismatch, and is not hidden either.
    expect(held()?.textContent).toBe('+1 held by owner')
  })

  it('keeps the plain total, with no badge, when nothing reads apart', () => {
    const rows = ['a', 'b'].map(session)
    renderGroup(computerGroup(rows))
    expect(headline()).toBe('2')
    expect(onlyHere()).toBeNull()
    expect(held()).toBeNull()

    cleanup()
    // An older owner's frame-vouched rows are listed only here but verified: still the headline.
    useSessionGroupParity.setState({
      byRowKey: new Map([
        ['a', fields('receiverOnly')],
        ['b', fields('ownerListed')]
      ])
    })
    renderGroup(computerGroup(rows))
    expect(headline()).toBe('2')
    expect(onlyHere()).toBeNull()
  })

  it("classifies the counted rows from the store: the owner's row listed, a stray capture apart", () => {
    const source = pairedSource()
    const stray = makePaneKey('7e0f2a9b-1c3d-4e5f-8a9b-0c1d2e3f4a5b', SESSION_TEST_LEAF)
    source.sleepingAgentSessionsByPaneKey[stray] = {
      paneKey: stray,
      tabId: stray.split(':')[0],
      worktreeId: SESSION_TEST_WORKTREE,
      agent: 'claude',
      providerSession: providerSession('stray'),
      prompt: '',
      state: 'working',
      capturedAt: 100,
      updatedAt: 100,
      origin: 'live'
    }
    Object.assign(source, ledgerSlices([ledgerBucket([ledgerRecord('s1')])]))
    act(() => {
      useAppStore.setState(source as Partial<typeof initialState>)
    })
    const sessions = buildSidebarSessions(source)
    renderHook(() => usePublishSessionGroupParity(sessions))

    const byRowKey = useSessionGroupParity.getState().byRowKey
    const listed = sessions.find((entry) => entry.mirroredConversation)!
    const capture = sessions.find((entry) => entry.paneKey === stray)!
    expect(byRowKey.get(listed.rowKey)).toMatchObject({
      bucket: 'ownerListed',
      verification: 'verified',
      identity: `c:${conversationDigest('s1')}`
    })
    expect(byRowKey.get(capture.rowKey)).toMatchObject({
      bucket: 'receiverOnly',
      verification: 'unverified'
    })

    renderGroup(computerGroup(sessions))
    expect(headline()).toBe('1')
    expect(onlyHere()?.textContent).toBe("+1 only here (can't verify)")
  })

  // The real lens tree gives every computer group a tally, which used to replace the headline and
  // the badges, so the two Macs' headings disagreed and nothing explained why.
  it('headlines and badges a computer group the real lens tree builds, beside its tally', () => {
    const rows = ['listed-1', 'listed-2', 'stray'].map(session)
    useSessionGroupParity.setState({
      byRowKey: new Map([
        ['listed-1', fields('ownerListed')],
        ['listed-2', fields('ownerListed')],
        ['stray', fields('receiverOnly', 'unverified')]
      ])
    })
    const tree = buildSessionSidebarTree({
      now: Date.now(),
      sessions: rows,
      metadata: emptySessionFolderMetadata(),
      view: withSessionSidebarGroupBy(emptySessionSidebarView(), 'computer'),
      archivedKeys: new Set(),
      snapshot: {
        cardsByPaneKey: new Map(),
        cardsByTabId: new Map(),
        attentionByPaneKey: new Map()
      },
      query: '',
      showHidden: false
    })
    const computer = tree.groups.find((group) => group.kind === 'computer')!
    expect(computer.rows).toHaveLength(3)
    expect(computer.folderTally?.total).toBe(3)
    renderGroup(computer)
    expect(headline()).toBe('2')
    expect(onlyHere()?.textContent).toBe("+1 only here (can't verify)")
    expect(document.body.textContent).toContain('done')
  })

  it("counts a folder's nested rows in its headline and badges, as its row count does", () => {
    const [own, nestedStray, nestedHeld] = ['own', 'nested-stray', 'nested-held'].map(session)
    useSessionGroupParity.setState({
      byRowKey: new Map([
        ['own', fields('ownerListed')],
        ['nested-stray', fields('receiverOnly', 'unverified')],
        ['nested-held', fields('heldByOwner')]
      ])
    })
    const ADS = '00000000-0000-4000-8000-00000000ad50'
    const RESEARCH = '00000000-0000-4000-8000-00000000ad51'
    renderGroup({
      key: `folder:${ADS}`,
      kind: 'folder',
      label: 'Ads',
      folder: { id: ADS, name: 'Ads' },
      rows: [treeRow(own!, ADS)],
      nestedRows: [treeRow(nestedStray!, RESEARCH), treeRow(nestedHeld!, RESEARCH)],
      childRowCount: 2,
      folderTally: {
        working: 0,
        needsYou: 0,
        waiting: 0,
        stopped: 0,
        cantSee: 0,
        done: 3,
        total: 3
      },
      collapsed: false,
      hidden: false,
      attentionCount: 0,
      canReorder: true,
      canHide: true
    })
    expect(headline()).toBe('1')
    expect(onlyHere()?.textContent).toBe("+1 only here (can't verify)")
    expect(held()?.textContent).toBe('+1 held by owner')
  })

  it('counts a launch still in flight on an unpaired computer as its own: no badge', () => {
    const source = sessionTestSource()
    addSessionTestTab(source, 'tab-settled')
    addSessionTestTab(source, 'tab-launching').conversationLaunchPending = true
    act(() => {
      useAppStore.setState(source as Partial<typeof initialState>)
    })
    const sessions = buildSidebarSessions(source)
    const launching = sessions.find((entry) => entry.launchPending)!
    expect(launching).toMatchObject({ hostId: 'local', sessionKey: null, paneKey: null })
    renderHook(() => usePublishSessionGroupParity(sessions))

    expect(useSessionGroupParity.getState().byRowKey.get(launching.rowKey)).toMatchObject({
      bucket: 'ownerListed',
      verification: 'verified',
      identity: null
    })
    renderGroup(computerGroup(sessions))
    expect(headline()).toBe('2')
    expect(onlyHere()).toBeNull()
    expect(held()).toBeNull()
  })
})
