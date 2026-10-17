import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import {
  refuseMirroredConversationDeletes,
  sessionManageDeleteEvidence
} from './mirrored-conversation-delete-guard'
import type { MirroredSidebarConversation } from './mirrored-conversation-row-types'
import { LEDGER_ENV } from './mirrored-conversation-test-fixtures'
import { SESSION_TEST_LEAF, SESSION_TEST_WORKTREE } from './sidebar-session-test-fixtures'
import type { SidebarSession } from './sidebar-sessions'

const mocks = vi.hoisted(() => ({ error: vi.fn(), state: {} as Record<string, unknown> }))
vi.mock('sonner', () => ({ toast: { error: mocks.error } }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))

const HOST = `runtime:${LEDGER_ENV}` as const
const CAPTURE_TAB = toWebTerminalSurfaceTabId('4c3e6035-ce3a-41cd-a874-7d9d1341abb2')
const CAPTURE_PANE = makePaneKey(CAPTURE_TAB, SESSION_TEST_LEAF)

function vouched(listed: boolean): MirroredSidebarConversation {
  return {
    environmentId: LEDGER_ENV,
    conversation: '0123456789abcdef01234567',
    ownerPaneKey: null,
    ownerTabId: null,
    rest: 'asleep',
    listed,
    stale: false,
    ownerState: 'ready'
  }
}

function row(overrides: Partial<SidebarSession>): SidebarSession {
  return {
    rowKey: 'row',
    sessionKey: 'row',
    worktreeId: SESSION_TEST_WORKTREE,
    hostId: HOST,
    tabId: null,
    paneKey: CAPTURE_PANE,
    kind: 'terminal',
    label: 'Owner conversation',
    workspaceLabel: 'Website',
    agent: 'claude',
    unavailable: false,
    folderKeyMigration: null,
    ...overrides
  }
}

const listed = row({ rowKey: 'listed', tabId: 'tab-mirror', mirroredConversation: vouched(true) })
/** This computer's own capture of an owner pane, which the owner holds without listing (G1). */
const held = row({ rowKey: 'held', mirroredConversation: vouched(false) })
const plain = row({ rowKey: 'plain' })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.state = { runtimeEnvironments: [{ id: LEDGER_ENV, name: 'Mac Studio' }] }
})

// Step 7 (C4/F10) with G1: only a conversation its owner LISTS is deleted on the owner; a capture
// the owner merely holds is this computer's own copy, which it may still clear.
describe('refuseMirroredConversationDeletes', () => {
  it('refuses the rows an owner lists, naming the computer, and lets held captures go', () => {
    expect(refuseMirroredConversationDeletes([listed, held, plain])).toEqual([held, plain])
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith(
      'Delete it on Mac Studio.',
      expect.objectContaining({ description: expect.stringContaining('“Owner conversation”') })
    )
  })

  it('says nothing when no row is listed by an owner', () => {
    expect(refuseMirroredConversationDeletes([held, plain])).toEqual([held, plain])
    expect(mocks.error).not.toHaveBeenCalled()
  })
})

describe('sessionManageDeleteEvidence', () => {
  const state = { tabsByWorktree: {}, unifiedTabsByWorktree: {} }

  it('names the owner for a listed row, so main refuses even --unverified', () => {
    expect(sessionManageDeleteEvidence(state, listed)).toEqual({
      mirroredConversationOwner: LEDGER_ENV
    })
  })

  it('reads a held capture as the record-only row it is, so --unverified may clear it', () => {
    expect(sessionManageDeleteEvidence(state, held)).toEqual({ recordOnlyMirror: true })
    // With a tab of its own here, the row is the tab's: no record-only flag, no owner.
    expect(sessionManageDeleteEvidence(state, { ...held, tabId: 'tab-here' })).toEqual({})
  })

  it('keeps the record-only flags of a row no owner vouches for', () => {
    expect(sessionManageDeleteEvidence(state, plain)).toEqual({ recordOnlyMirror: true })
  })
})
