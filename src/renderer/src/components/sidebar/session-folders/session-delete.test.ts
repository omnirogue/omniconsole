import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { MirroredSidebarConversation } from '@/lib/mirrored-conversation-row-types'
import { mirroredConversationRowKey } from '@/lib/mirrored-conversation-rows'
import { makePaneKey } from '../../../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../../../shared/terminal-surface-id'

const mocks = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), warning: vi.fn() }),
  deleteByPerson: vi.fn((_keys: readonly string[], _deleted: boolean) => true),
  retract: vi.fn((_paneKeys: Iterable<string>) => () => {}),
  close: vi.fn(async (_tabId: string) => 'closed' as const),
  working: vi.fn((_tabId: string) => false)
}))
vi.mock('sonner', () => ({ toast: mocks.toast }))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ runtimeEnvironments: [{ id: STUDIO, name: 'Mac Studio' }] })
  }
}))
vi.mock('@/lib/session-organization-person-changes', () => ({
  deleteSessionsByPerson: mocks.deleteByPerson
}))
vi.mock('@/lib/record-only-mirror-row-retraction', () => ({
  retractRecordOnlyMirrorRows: mocks.retract
}))
vi.mock('./session-bulk-delete', () => ({
  closeSessionTabForBulk: mocks.close,
  isSessionTabWorking: mocks.working
}))

const { deleteSidebarSessions, workingSessions } = await import('./session-delete')

const STUDIO = '1d045bce-9849-4ceb-94b6-3e36aeca3513'
const WT = 'paired-repo::/Users/maintainer/Work'
const LEAF = 'cf50cc26-0360-45ed-9a19-3f94e3d56068'
const MIRROR_TAB = toWebTerminalSurfaceTabId('9526cd53-8dc2-43b3-9ee2-4054a8a372fb')

function row(overrides: Partial<SidebarSession>): SidebarSession {
  return {
    rowKey: 'row',
    sessionKey: null,
    worktreeId: WT,
    hostId: 'local',
    tabId: null,
    paneKey: null,
    kind: 'terminal',
    label: 'Conversation',
    workspaceLabel: 'Work',
    agent: 'claude',
    unavailable: false,
    folderKeyMigration: null,
    ...overrides
  }
}

const MIRRORED: MirroredSidebarConversation = {
  environmentId: STUDIO,
  conversation: '0123456789abcdef01234567',
  ownerPaneKey: null,
  ownerTabId: null,
  rest: 'asleep',
  stale: false,
  listed: true,
  ownerState: 'ready'
}

// The owner's ledger row (no tab here) and a live mirror tab the ledger joined.
const ledgerRow = row({
  rowKey: mirroredConversationRowKey(STUDIO, WT, MIRRORED),
  hostId: `runtime:${STUDIO}`,
  label: 'Owner paused',
  mirroredConversation: MIRRORED
})
const joinedTabRow = row({
  rowKey: JSON.stringify([`runtime:${STUDIO}`, WT, makePaneKey(MIRROR_TAB, LEAF)]),
  hostId: `runtime:${STUDIO}`,
  tabId: MIRROR_TAB,
  paneKey: makePaneKey(MIRROR_TAB, LEAF),
  label: 'Owner live',
  mirroredConversation: { ...MIRRORED, rest: 'live' }
})
// This computer's own row, a direct-SSH row and a receiver-only capture of the owner's pane.
const localRow = row({ rowKey: 'local-row', tabId: 'local-tab', label: 'Mine' })
const sshRow = row({ rowKey: 'ssh-row', hostId: 'ssh:build-box', tabId: 'ssh-tab' })
const captureRow = row({
  rowKey: 'capture-row',
  hostId: `runtime:${STUDIO}`,
  paneKey: makePaneKey(toWebTerminalSurfaceTabId('closed-host-tab'), LEAF)
})

beforeEach(() => vi.clearAllMocks())

describe('deleting rows whose conversation a paired owner runs (session parity, step 7)', () => {
  it('refuses ledger rows with "Delete it on <Computer>", touching neither tab nor mark', async () => {
    expect(await deleteSidebarSessions([ledgerRow, joinedTabRow])).toEqual([])

    expect(mocks.toast.error).toHaveBeenCalledWith('Delete it on Mac Studio.', {
      description: '2 run on another computer, so they were not deleted here.'
    })
    // Why: closing the joined mirror tab would stop the conversation on its owner.
    expect(mocks.close).not.toHaveBeenCalled()
    expect(mocks.deleteByPerson).not.toHaveBeenCalled()
  })

  it("keeps this computer's own, direct-SSH and receiver-only rows deletable as today (C4)", async () => {
    const keys = await deleteSidebarSessions([ledgerRow, localRow, sshRow, captureRow])

    expect(keys.sort()).toEqual(['capture-row', 'local-row', 'ssh-row'])
    expect(mocks.close.mock.calls.map(([tabId]) => tabId).sort()).toEqual(['local-tab', 'ssh-tab'])
    expect(mocks.deleteByPerson).toHaveBeenCalledWith(keys, true)
    // Why: a receiver-only capture goes with its record (A4); the ledger row was refused.
    expect(mocks.retract).toHaveBeenCalledWith([captureRow.paneKey])
    expect(mocks.toast.error).toHaveBeenCalledWith('Delete it on Mac Studio.', {
      description: '“Owner paused” runs there, so it was not deleted here.'
    })
  })

  it('never asks to stop a working ledger row it is about to refuse', () => {
    mocks.working.mockReturnValue(true)
    expect(workingSessions([joinedTabRow, localRow])).toEqual([localRow])
  })
})
