import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrganizationRelayedChange } from '../../../shared/session-organization-change'
import {
  emptySessionEvidence,
  STEWARD_EMPTY_SESSION_CLOSE_REASON
} from '../../../shared/session-steward-empty-session'

const LEAF = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF = '22222222-2222-4222-8222-222222222222'
const PANE = `tab-1:${LEAF}`

const mocks = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  leaves: [] as string[],
  onScreen: false
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ terminalLayoutsByTabId: { 'tab-1': { root: { type: 'leaf' } } } })
  }
}))
vi.mock('@/components/terminal-pane/terminal-layout-leaf-ids', () => ({
  collectLeafIdsInOrder: () => mocks.leaves
}))
vi.mock('./session-manage-sidebar-rows', () => ({
  buildSessionManageSidebarRows: () => mocks.rows
}))
vi.mock('./session-done-archive-policy', () => ({
  isSessionTabOnScreen: () => mocks.onScreen
}))

const { stewardCloseRefusal } = await import('./session-steward-close-check')

const blank = {
  viewKey: 'blank-session',
  paneKey: PANE,
  tabId: 'tab-1',
  pinned: false,
  folded: false,
  emptyArchiveRevision: 'idle-1'
}
const close = (extra: Partial<OrganizationRelayedChange> = {}): OrganizationRelayedChange => ({
  opId: 'op',
  executor: { kind: 'app', feature: 'steward' },
  reason: STEWARD_EMPTY_SESSION_CLOSE_REASON,
  evidence: `nobody prompted it · idle 2 min; ${emptySessionEvidence(blank.viewKey, 'idle-1')}`,
  ...extra
})
const target = { paneKey: PANE, tabId: 'tab-1' }

beforeEach(() => {
  mocks.rows = [blank]
  mocks.leaves = [LEAF]
  mocks.onScreen = false
})

describe('the window’s last check before a steward close', () => {
  it('lets the blank session it judged go, and ignores anything a person or command asked', () => {
    expect(stewardCloseRefusal(close(), target)).toBeNull()
    expect(stewardCloseRefusal(undefined, target)).toBeNull()
    expect(stewardCloseRefusal({ opId: 'op', executor: { kind: 'cli' } }, target)).toBeNull()
  })

  it('keeps it when a keystroke, prompt, status or look changed the revision since', () => {
    for (const changed of [
      { emptyArchiveRevision: 'idle-2' },
      // Why null: on screen, typed into, working, asking or held.
      { emptyArchiveRevision: null },
      { pinned: true },
      { folded: true }
    ]) {
      mocks.rows = [{ ...blank, ...changed }]
      expect(stewardCloseRefusal(close(), target), JSON.stringify(changed)).not.toBeNull()
    }
    mocks.rows = [blank]
    expect(stewardCloseRefusal(close({ evidence: 'nobody prompted it' }), target)).toMatch(
      /no longer blank/
    )
  })

  it('never closes the pane on screen, or a tab that holds another pane', () => {
    mocks.onScreen = true
    expect(stewardCloseRefusal(close(), target)).toMatch(/on screen/)
    mocks.onScreen = false
    mocks.leaves = [LEAF, OTHER_LEAF]
    expect(stewardCloseRefusal(close(), target)).toMatch(/other panes/)
  })

  it('refuses a steward delete that is not the blank-session rule’s', () => {
    expect(stewardCloseRefusal(close({ reason: 'tidy up' }), target)).toMatch(/only a blank/)
  })
})
