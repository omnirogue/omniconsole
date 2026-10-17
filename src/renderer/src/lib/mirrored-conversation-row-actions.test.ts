import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../shared/stable-pane-id'
import {
  isLedgerOnlyRow,
  isOwnerPlacedRow,
  ledgerOnlyRowRefusal,
  ownerPlacedRowRefusal,
  withoutLedgerOnlyRows,
  withoutOwnerPlacedRows
} from './mirrored-conversation-row-actions'
import {
  addMirrorTab,
  LEDGER_ENV,
  ledgerBucket,
  ledgerRecord,
  ledgerSlices,
  OWNER_PANE,
  OWNER_TAB,
  pairedSource,
  providerSession
} from './mirrored-conversation-test-fixtures'
import { SESSION_TEST_LEAF, SESSION_TEST_WORKTREE } from './sidebar-session-test-fixtures'
import {
  buildSidebarSessions,
  type SidebarSession,
  type SidebarSessionSource
} from './sidebar-sessions'

const mocks = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))

const CAPTURE_PANE = makePaneKey('4c3e6035-ce3a-41cd-a874-7d9d1341abb2', SESSION_TEST_LEAF)

function withLedger(
  source: SidebarSessionSource,
  ...args: Parameters<typeof ledgerSlices>
): SidebarSessionSource {
  return Object.assign(source, ledgerSlices(...args))
}

function onlyRow(source: SidebarSessionSource): SidebarSession {
  const rows = buildSidebarSessions(source)
  expect(rows).toHaveLength(1)
  return rows[0]!
}

beforeEach(() => {
  mocks.state = { runtimeEnvironments: [{ id: LEDGER_ENV, name: 'Mac Studio' }] }
})

// E1/F13 (session parity, Phase 1b): only rows the owner's ledger created lose their actions here;
// the rows it joined, this computer's captures and its own rows keep theirs.
describe('which rows a paired owner’s ledger created (E1/F13)', () => {
  it('names a record row and a row placed on a pending-handle mirror tab', () => {
    const record = onlyRow(withLedger(pairedSource(), [ledgerBucket([ledgerRecord('s1')])]))
    expect(record).toMatchObject({ tabId: null, paneKey: null })
    expect(isLedgerOnlyRow(record)).toBe(true)
    expect(ledgerOnlyRowRefusal(record)).toBe('Open it on Mac Studio.')

    const source = pairedSource()
    const tab = addMirrorTab(source, OWNER_TAB, null)
    const pending = onlyRow(
      withLedger(source, [
        ledgerBucket([ledgerRecord('s1', { paneKey: OWNER_PANE, rest: 'asleep' })])
      ])
    )
    // Why it still counts: the dormant tab had no row; the row is the ledger's, on that tab.
    expect(pending.tabId).toBe(tab.id)
    expect(isLedgerOnlyRow(pending)).toBe(true)
    expect(ledgerOnlyRowRefusal(pending)).toBe('Open it on Mac Studio.')
  })

  it('leaves a live mirror row the ledger joined, a held capture and a local row alone', () => {
    const source = pairedSource()
    addMirrorTab(source)
    const joined = onlyRow(
      withLedger(source, [ledgerBucket([ledgerRecord('s1', { paneKey: OWNER_PANE })])])
    )
    expect(joined.mirroredConversation?.rest).toBe('live')
    expect(isLedgerOnlyRow(joined)).toBe(false)
    expect(ledgerOnlyRowRefusal(joined)).toBeNull()

    const held = pairedSource()
    held.sleepingAgentSessionsByPaneKey[CAPTURE_PANE] = {
      paneKey: CAPTURE_PANE,
      tabId: CAPTURE_PANE.split(':')[0],
      worktreeId: SESSION_TEST_WORKTREE,
      agent: 'claude',
      providerSession: providerSession('s1'),
      prompt: '',
      terminalTitle: 'Advertising check',
      state: 'working',
      capturedAt: 100,
      updatedAt: 100,
      origin: 'live'
    }
    const capture = onlyRow(
      withLedger(held, [ledgerBucket([ledgerRecord('s1', { listed: false })])])
    )
    expect(capture.mirroredConversation?.listed).toBe(false)
    expect(isLedgerOnlyRow(capture)).toBe(false)

    const local = { ...joined, hostId: 'local' as const, mirroredConversation: undefined }
    expect(isLedgerOnlyRow(local)).toBe(false)
    expect(ledgerOnlyRowRefusal(local)).toBeNull()
  })

  // E1 for filing: a row its owner places (the ledger states a folder, null included) is filed
  // there, since the tree reads the owner's folder first; a local move could never show.
  it('names the rows an owner places: a joined row with an explicit owner folder, unfiled included', () => {
    const joinedWith = (folderId: string | null | undefined): SidebarSession => {
      const source = pairedSource()
      addMirrorTab(source)
      return onlyRow(
        withLedger(source, [
          ledgerBucket([
            ledgerRecord('s1', {
              paneKey: OWNER_PANE,
              ...(folderId === undefined ? {} : { folderId })
            })
          ])
        ])
      )
    }
    const unfiledByOwner = joinedWith(null)
    expect(unfiledByOwner.mirroredConversation?.folderIdByOwner).toBeNull()
    expect(isLedgerOnlyRow(unfiledByOwner)).toBe(false)
    expect(isOwnerPlacedRow(unfiledByOwner)).toBe(true)
    expect(ownerPlacedRowRefusal(unfiledByOwner)).toBe('Open it on Mac Studio.')
    expect(isOwnerPlacedRow(joinedWith('ads'))).toBe(true)
    // The owner did not say: the local filing stands, so the row still moves here.
    const unsaid = joinedWith(undefined)
    expect(isOwnerPlacedRow(unsaid)).toBe(false)
    expect(ownerPlacedRowRefusal(unsaid)).toBeNull()
    const ledgerOnly = onlyRow(withLedger(pairedSource(), [ledgerBucket([ledgerRecord('s1')])]))
    expect(isOwnerPlacedRow(ledgerOnly)).toBe(true)
    expect(withoutOwnerPlacedRows([unfiledByOwner, unsaid, ledgerOnly])).toEqual([unsaid])
  })

  it('drops only the ledger-only rows from a bulk or group action', () => {
    const source = pairedSource()
    addMirrorTab(source)
    const rows = buildSidebarSessions(
      withLedger(source, [
        ledgerBucket([ledgerRecord('s1', { paneKey: OWNER_PANE }), ledgerRecord('s2')])
      ])
    )
    expect(rows).toHaveLength(2)
    expect(withoutLedgerOnlyRows(rows).map((row) => row.mirroredConversation?.rest)).toEqual([
      'live'
    ])
  })
})
