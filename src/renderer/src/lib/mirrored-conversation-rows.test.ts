import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../shared/tab-types'
import { providerSessionFolderKey } from '../../../shared/session-folder-identity'
import { toRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import { makePaneKey } from '../../../shared/stable-pane-id'
import {
  toOwnerQualifiedWebTerminalSurfaceTabId,
  toWebTerminalSurfaceTabId
} from '../../../shared/terminal-surface-id'
import {
  mirroredConversationRowKey,
  mirroredConversationRows,
  resolveOwnerArchive
} from './mirrored-conversation-rows'
import {
  addMirrorTab,
  conversationDigest,
  LEDGER_ENV,
  ledgerBucket,
  ledgerOwner,
  ledgerRecord,
  ledgerSlices,
  OWNER_PANE,
  OWNER_TAB,
  pairedSource,
  providerSession
} from './mirrored-conversation-test-fixtures'
import { sessionRowFolderId } from './mirrored-conversation-folders'
import { emptySessionFolderMetadata } from './session-folders'
import { sidebarWorkspaceContexts } from './sidebar-session-context'
import {
  addSessionTestTab,
  SESSION_TEST_LEAF,
  SESSION_TEST_WORKTREE
} from './sidebar-session-test-fixtures'
import {
  buildSidebarSessions,
  type SidebarSession,
  type SidebarSessionSource
} from './sidebar-sessions'

const W = SESSION_TEST_WORKTREE
const HOST = `runtime:${LEDGER_ENV}` as const
const CAPTURE_PANE = makePaneKey('4c3e6035-ce3a-41cd-a874-7d9d1341abb2', SESSION_TEST_LEAF)

/** This computer's own record of an owner pane, re-keyed onto a plain-UUID tab (C4). */
function addCapture(
  source: SidebarSessionSource,
  id: string,
  extra: { connectionId?: string; paneKey?: string } = {}
): string {
  const paneKey = extra.paneKey ?? CAPTURE_PANE
  source.sleepingAgentSessionsByPaneKey[paneKey] = {
    paneKey,
    tabId: paneKey.split(':')[0],
    worktreeId: W,
    agent: 'claude',
    providerSession: providerSession(id),
    prompt: 'Look at the ads',
    terminalTitle: 'Advertising check',
    state: 'working',
    capturedAt: 100,
    updatedAt: 100,
    origin: 'live',
    ...(extra.connectionId ? { connectionId: extra.connectionId } : {})
  }
  return paneKey
}

function withLedger(
  source: SidebarSessionSource,
  ...args: Parameters<typeof ledgerSlices>
): SidebarSessionSource {
  return Object.assign(source, ledgerSlices(...args))
}

describe('ledger rows on a paired receiver (session parity, step 6)', () => {
  it('joins a tab record onto the mirror row already built, keeping its frame key', () => {
    const source = pairedSource()
    const tab = addMirrorTab(source)
    const [frame] = buildSidebarSessions(source)
    withLedger(source, [ledgerBucket([ledgerRecord('s1', { paneKey: OWNER_PANE })])])

    const rows = buildSidebarSessions(source)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      rowKey: frame!.rowKey,
      sessionKey: frame!.sessionKey,
      hostId: HOST,
      tabId: tab.id,
      paneKey: makePaneKey(tab.id, SESSION_TEST_LEAF),
      mirroredConversation: {
        environmentId: LEDGER_ENV,
        conversation: conversationDigest('s1'),
        ownerPaneKey: OWNER_PANE,
        ownerTabId: OWNER_TAB,
        rest: 'live',
        listed: true,
        stale: false,
        ownerState: 'ready'
      }
    })
  })

  it('gives one owner pane one row: the newest listed record takes it, the other goes tab-less', () => {
    const source = pairedSource()
    const tab = addMirrorTab(source)
    const old = ledgerRecord('s1', { paneKey: OWNER_PANE, updatedAt: 1, rest: 'asleep' })
    const current = ledgerRecord('s2', { paneKey: OWNER_PANE, updatedAt: 2, folderId: 'ads' })
    withLedger(source, [ledgerBucket([old, current])])

    const rows = buildSidebarSessions(source)
    expect(rows).toHaveLength(2)
    const onPane = rows.filter((row) => row.tabId === tab.id)
    expect(onPane).toHaveLength(1)
    expect(onPane[0]).toMatchObject({
      label: 'Owner s2',
      mirroredConversation: {
        conversation: conversationDigest('s2'),
        rest: 'live',
        folderIdByOwner: 'ads'
      }
    })
    expect(rows.find((row) => row.tabId !== tab.id)).toMatchObject({
      rowKey: mirroredConversationRowKey(LEDGER_ENV, W, old),
      tabId: null,
      paneKey: null,
      mirroredConversation: { conversation: conversationDigest('s1'), rest: 'asleep' }
    })
  })

  it('lets the record matching what the pane row here claims take the pane, even when older', () => {
    const source = pairedSource()
    const tab = addMirrorTab(source)
    // This window's own record of the pane names conversation s1, so the row claims s1.
    addCapture(source, 's1', { paneKey: makePaneKey(tab.id, SESSION_TEST_LEAF) })
    const old = ledgerRecord('s1', { paneKey: OWNER_PANE, updatedAt: 1 })
    const current = ledgerRecord('s2', { paneKey: OWNER_PANE, updatedAt: 2 })
    withLedger(source, [ledgerBucket([old, current])])

    const rows = buildSidebarSessions(source)
    const onPane = rows.filter((row) => row.tabId === tab.id)
    expect(onPane).toHaveLength(1)
    expect(onPane[0]?.mirroredConversation?.conversation).toBe(conversationDigest('s1'))
    expect(rows.find((row) => row.tabId !== tab.id)).toMatchObject({
      rowKey: mirroredConversationRowKey(LEDGER_ENV, W, current),
      tabId: null
    })
  })

  it('names a joined row by the owner only when its frame carried no owner title and it was not renamed here', () => {
    const source = pairedSource()
    const tab = addMirrorTab(source)
    withLedger(source, [ledgerBucket([ledgerRecord('s1', { paneKey: OWNER_PANE })])])
    expect(buildSidebarSessions(source)[0]).toMatchObject({
      label: 'Owner s1',
      labelSource: 'custom'
    })
    tab.runtimeOwnerTitleByLeafId = { [SESSION_TEST_LEAF]: 'Studio name' }
    expect(buildSidebarSessions(source)[0]?.label).toBe('Studio name')
    tab.customTitle = 'Mine'
    expect(buildSidebarSessions(source)[0]?.label).toBe('Mine')
  })

  it('makes the record the row of a dormant mirror tab no row was built for, on that tab', () => {
    const source = pairedSource()
    const tab = addMirrorTab(source, OWNER_TAB, null)
    expect(buildSidebarSessions(source)).toEqual([])
    const record = ledgerRecord('s1', { paneKey: OWNER_PANE, rest: 'asleep' })
    withLedger(source, [ledgerBucket([record])])

    const rows = buildSidebarSessions(source)
    const key = mirroredConversationRowKey(LEDGER_ENV, W, record)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      rowKey: key,
      sessionKey: key,
      hostId: HOST,
      tabId: tab.id,
      paneKey: makePaneKey(tab.id, SESSION_TEST_LEAF),
      mirroredConversation: { rest: 'asleep', ownerTabId: OWNER_TAB }
    })
  })

  it('makes a record-only conversation a row keyed by owner, workspace and digest (F21)', () => {
    const source = withLedger(pairedSource(), [ledgerBucket([ledgerRecord('s1')])])
    const [row] = buildSidebarSessions(source)
    const key = JSON.stringify([HOST, 'ledger', W, `c:${conversationDigest('s1')}`])
    expect(row).toMatchObject({
      rowKey: key,
      sessionKey: key,
      hostId: HOST,
      worktreeId: W,
      tabId: null,
      paneKey: null,
      kind: 'terminal',
      label: 'Owner s1',
      agent: 'claude',
      providerSession: { key: 'session_id', id: 's1' },
      mirroredConversation: { rest: 'asleep', ownerPaneKey: null, ownerTabId: null }
    })
  })

  it('reads a conversation with no title of its own as "<agent> (untitled)", whatever title came', () => {
    for (const title of ['claude', 'claude (untitled)']) {
      const record = ledgerRecord('s1', { title, titleSource: 'agent' })
      const [row] = buildSidebarSessions(withLedger(pairedSource(), [ledgerBucket([record])]))
      expect(row).toMatchObject({ label: 'claude (untitled)', labelSource: 'agent' })
    }
  })

  it('never makes a listed:false record a row: it vouches for this computer’s capture (G1)', () => {
    const held = ledgerRecord('s1', { listed: false })
    expect(buildSidebarSessions(withLedger(pairedSource(), [ledgerBucket([held])]))).toEqual([])

    const source = pairedSource()
    addCapture(source, 's1')
    withLedger(source, [ledgerBucket([held])])
    const rows = buildSidebarSessions(source)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      paneKey: CAPTURE_PANE,
      tabId: null,
      mirroredConversation: { listed: false, rest: 'asleep' }
    })
  })

  it('folds this computer’s capture into the owner’s row, never a row this computer runs', () => {
    const source = pairedSource()
    addCapture(source, 's1')
    const record = ledgerRecord('s1')
    withLedger(source, [ledgerBucket([record])])
    expect(buildSidebarSessions(source).map((row) => row.rowKey)).toEqual([
      mirroredConversationRowKey(LEDGER_ENV, W, record)
    ])

    // A row of this computer with the same host-stripped claim is never folded onto.
    const local: SidebarSession = {
      rowKey: JSON.stringify(['local', W, 'local-tab']),
      sessionKey: providerSessionFolderKey({
        hostId: 'local',
        worktreeId: W,
        agent: 'claude',
        providerSession: providerSession('s1')
      }),
      worktreeId: W,
      hostId: 'local',
      tabId: null,
      paneKey: null,
      kind: 'terminal',
      label: 'Mine',
      workspaceLabel: 'Project A / main',
      agent: 'claude',
      unavailable: false,
      folderKeyMigration: null
    }
    const rows = mirroredConversationRows([local], source, sidebarWorkspaceContexts(source))
    expect(rows[0]).toBe(local)
    expect(rows).toHaveLength(2)
  })

  it('joins each owner’s record onto its own mirror when two owners publish identical ids (F8)', () => {
    const source = pairedSource('env-a')
    const tabA = addSessionTestTab(source, toWebTerminalSurfaceTabId('tab-1'))
    tabA.ptyId = toRemoteRuntimePtyId('term-a', 'env-a')
    const tabB = addSessionTestTab(
      source,
      toOwnerQualifiedWebTerminalSurfaceTabId('env-b', 'tab-1')
    )
    tabB.ptyId = toRemoteRuntimePtyId('term-b', 'env-b')
    source.unifiedTabsByWorktree[W] = [
      { id: 'u-a', entityId: tabA.id, contentType: 'terminal', executionHostId: 'runtime:env-a' },
      { id: 'u-b', entityId: tabB.id, contentType: 'terminal', executionHostId: 'runtime:env-b' }
    ] as unknown as Tab[]
    // And a direct-SSH record of the same provider conversation in the same workspace.
    addCapture(source, 's1', { connectionId: 'box' })
    const pane = makePaneKey('tab-1', SESSION_TEST_LEAF)
    const record = (title: string) => ledgerRecord('s1', { paneKey: pane, title })
    withLedger(
      source,
      [
        ledgerBucket([record('From A')], { environmentId: 'env-a' }),
        ledgerBucket([record('From B')], { environmentId: 'env-b' })
      ],
      [ledgerOwner({ environmentId: 'env-a' }), ledgerOwner({ environmentId: 'env-b' })]
    )

    const rows = buildSidebarSessions(source)
    expect(rows).toHaveLength(3)
    expect(rows.find((row) => row.tabId === tabA.id)).toMatchObject({
      label: 'From A',
      mirroredConversation: { environmentId: 'env-a' }
    })
    expect(rows.find((row) => row.tabId === tabB.id)).toMatchObject({
      label: 'From B',
      mirroredConversation: { environmentId: 'env-b' }
    })
    const ssh = rows.find((row) => row.hostId === 'ssh:box')
    expect(ssh?.paneKey).toBe(CAPTURE_PANE)
    expect(ssh?.mirroredConversation).toBeUndefined()
  })

  it('lets an explicit owner mark win over the frame’s, and keeps the frame’s when it says nothing (C3)', () => {
    const frame = { archived: true, byHand: true }
    expect(resolveOwnerArchive(undefined, frame)).toBe(frame)
    expect(resolveOwnerArchive({ archived: false }, frame)).toEqual({
      archived: false,
      byHand: false
    })
    expect(resolveOwnerArchive({ archived: true }, undefined)).toEqual({
      archived: true,
      byHand: true
    })
    expect(resolveOwnerArchive({ archived: true, byHand: false }, frame)).toEqual({
      archived: true,
      byHand: false
    })

    const source = pairedSource()
    const tab = addMirrorTab(source)
    tab.runtimeOwnerArchiveByLeafId = { [SESSION_TEST_LEAF]: frame }
    withLedger(source, [
      ledgerBucket([ledgerRecord('s1', { paneKey: OWNER_PANE, archived: { archived: false } })])
    ])
    expect(buildSidebarSessions(source)[0]).toMatchObject({
      ownerArchive: { archived: false, byHand: false },
      mirroredConversation: { archivedByOwner: false }
    })
  })

  // C3's recency: a frozen bucket (an older owner, a restored snapshot) can be behind the owner's
  // live frame, so it vouches for the joined row's presence only; the frame, the local filing
  // and this computer's own record of the pane stand, as before the ledger.
  it.each([
    ['older', { ownerState: 'older' as const }],
    ['stale', { ownerState: 'stale' as const, stale: true as const }]
  ])('lets the frame, the local folder and the frame title win over a %s bucket', (_, state) => {
    const folder = { id: '00000000-0000-4000-8000-0000000000f2', name: 'Ads' }
    const source = pairedSource()
    const tab = addMirrorTab(source)
    tab.runtimeOwnerArchiveByLeafId = { [SESSION_TEST_LEAF]: { archived: true, byHand: true } }
    const record = ledgerRecord('s1', {
      paneKey: OWNER_PANE,
      archived: { archived: false },
      folderId: folder.id,
      hidden: true,
      rest: 'asleep'
    })
    withLedger(source, [ledgerBucket([record], state)], [ledgerOwner({ folders: [folder] })])
    const [row] = buildSidebarSessions(source)
    expect(row).toMatchObject({
      tabId: tab.id,
      ownerArchive: { archived: true, byHand: true },
      mirroredConversation: {
        conversation: conversationDigest('s1'),
        listed: true,
        ownerState: state.ownerState,
        rest: 'unknown'
      }
    })
    expect(row?.label).not.toBe('Owner s1')
    for (const field of ['archivedByOwner', 'folderIdByOwner', 'folderByOwner', 'hidden']) {
      expect(row?.mirroredConversation).not.toHaveProperty(field)
    }
    const local = { id: '00000000-0000-4000-8000-0000000000f3', name: 'Mine' }
    const metadata = {
      ...emptySessionFolderMetadata(),
      folders: [local],
      membership: { [row!.sessionKey!]: local.id }
    }
    expect(sessionRowFolderId(metadata, row!, row!.sessionKey!)).toBe(local.id)
    // A row of the owner's own has no frame here: the frozen record is all there is to show.
    const own = buildSidebarSessions(
      withLedger(pairedSource(), [ledgerBucket([ledgerRecord('s2', { rest: 'asleep' })], state)])
    )[0]
    expect(own?.mirroredConversation?.rest).toBe('asleep')
  })

  it('carries the owner’s folder, its definition and the owner’s state for the counts (step 8)', () => {
    const folder = { id: '00000000-0000-4000-8000-0000000000f1', name: 'Ads' }
    const source = withLedger(
      pairedSource(),
      [
        ledgerBucket([ledgerRecord('s1', { folderId: folder.id, hidden: false })], {
          stale: true,
          ownerState: 'stale'
        })
      ],
      [ledgerOwner({ state: 'stale', folders: [folder] })]
    )
    expect(buildSidebarSessions(source)[0]?.mirroredConversation).toMatchObject({
      folderIdByOwner: folder.id,
      folderByOwner: folder,
      hidden: false,
      stale: true,
      ownerState: 'stale'
    })
  })
})
