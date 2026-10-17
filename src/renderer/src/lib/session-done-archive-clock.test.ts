import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrganizationChange } from '../../../shared/session-organization-change'
import { DONE_ARCHIVE_IDLE_REASON, doneArchiveEvidence } from '../../../shared/session-done-archive'
import {
  emptySessionEvidence,
  STEWARD_EMPTY_SESSION_REASON
} from '../../../shared/session-steward-empty-session'

const mocks = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  chain: null as object | null,
  view: { loaded: true, archiveStorageReady: true }
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({}), subscribe: () => () => {} }
}))
vi.mock('@/store/session-sidebar-view', () => ({
  useSessionSidebarView: { getState: () => mocks.view, subscribe: () => () => {} }
}))
vi.mock('@/store/session-folders', () => ({
  useSessionFolders: { getState: () => ({ loaded: true }), subscribe: () => () => {} }
}))
vi.mock('@/store/wait-later-store', () => ({ useWaitLater: { subscribe: () => () => {} } }))
vi.mock('@/components/attention/use-agent-pane-snapshot', () => ({
  selectAgentPaneSnapshotInputs: () => ({})
}))
vi.mock('./session-chain-registry', () => ({ findShownSessionChainForRow: () => mocks.chain }))
vi.mock('./session-manage-sidebar-rows', () => ({
  buildSessionManageSidebarRows: () => mocks.rows
}))

const { automaticArchiveRefusal } = await import('./session-done-archive-clock')

const clock = { revision: 'rev-1', since: 1 }
const finished = {
  viewKey: 'done-session',
  paneKey: 'term:tab-1:pane-1',
  tabId: 'tab-1',
  pinned: false,
  folded: false,
  saved: false,
  launchPending: false,
  waitingUntil: null,
  autoArchiveKeep: false,
  doneArchiveRevision: clock.revision,
  doneArchivePolicy: { ...clock, delayMs: 1 },
  emptyArchiveRevision: null
}
const empty = {
  ...finished,
  viewKey: 'empty-session',
  paneKey: 'term:tab-2:pane-1',
  tabId: 'tab-2',
  doneArchiveRevision: null,
  doneArchivePolicy: null,
  emptyArchiveRevision: 'idle-1'
}
const emptyEvidence = `nobody prompted it · idle 31 min; ${emptySessionEvidence(empty.viewKey, 'idle-1')}`

function stewardArchive(
  target: { paneKey: string; tabId: string },
  extra: Partial<OrganizationChange>
): OrganizationChange {
  return {
    opId: 'op',
    kind: 'archive',
    targets: [target],
    value: true,
    executor: { kind: 'app', feature: 'steward' },
    ...extra
  }
}

beforeEach(() => {
  mocks.rows = [finished, empty]
  mocks.chain = null
  mocks.view = { loaded: true, archiveStorageReady: true }
})

describe('the last synchronous check before a steward archive', () => {
  it('lets a finished session through only with its due Done clock in the evidence', () => {
    const target = { paneKey: finished.paneKey, tabId: finished.tabId }
    const evidence = `${doneArchiveEvidence(finished.viewKey, clock)}; reviewed`
    expect(
      automaticArchiveRefusal(stewardArchive(target, { reason: 'finished', evidence }))
    ).toBeNull()
    expect(
      automaticArchiveRefusal(stewardArchive(target, { reason: 'finished', evidence: 'reviewed' }))
    ).toMatch(/Done clock/)
  })

  it('lets an empty session through on its own rule, without a Done clock', () => {
    const target = { paneKey: empty.paneKey, tabId: empty.tabId }
    const change = stewardArchive(target, {
      reason: STEWARD_EMPTY_SESSION_REASON,
      evidence: emptyEvidence
    })
    expect(automaticArchiveRefusal(change)).toBeNull()
  })

  it('refuses the empty-session archive when the row moved on after the judgment', () => {
    const target = { paneKey: empty.paneKey, tabId: empty.tabId }
    const change = stewardArchive(target, {
      reason: STEWARD_EMPTY_SESSION_REASON,
      evidence: emptyEvidence
    })
    for (const changed of [
      // Why: a prompt, work or attention after the judgment changes or clears the revision.
      { emptyArchiveRevision: 'idle-2' },
      { emptyArchiveRevision: null },
      { pinned: true },
      { folded: true }
    ]) {
      mocks.rows = [finished, { ...empty, ...changed }]
      expect(automaticArchiveRefusal(change), JSON.stringify(changed)).not.toBeNull()
    }
    mocks.rows = [finished, empty]
    expect(
      automaticArchiveRefusal(stewardArchive(target, { reason: STEWARD_EMPTY_SESSION_REASON }))
    ).toMatch(/no longer empty and idle/)
  })

  it('archives an empty pane whose SessionStart alone left a Done clock', () => {
    // Why: Claude's SessionStart lands a "done" status, so an untouched pane carries a Done
    // revision and clock; the empty rule must not be held to them (live test, 2026-09-27).
    mocks.rows = [
      finished,
      {
        ...empty,
        doneArchiveRevision: 'start-only',
        doneArchivePolicy: { revision: 'start-only', since: 1, delayMs: 1 }
      }
    ]
    expect(
      automaticArchiveRefusal(
        stewardArchive(
          { paneKey: empty.paneKey, tabId: empty.tabId },
          {
            reason: STEWARD_EMPTY_SESSION_REASON,
            evidence: emptyEvidence
          }
        )
      )
    ).toBeNull()
  })

  it('never lets the empty-session reason bypass the Done guard for a finished session', () => {
    const target = { paneKey: finished.paneKey, tabId: finished.tabId }
    expect(
      automaticArchiveRefusal(
        stewardArchive(target, {
          reason: STEWARD_EMPTY_SESSION_REASON,
          evidence: `nobody prompted it · idle 31 min; ${emptySessionEvidence(finished.viewKey, 'idle-1')}`
        })
      )
    ).toMatch(/no longer empty and idle/)
  })

  it('ignores changes that are not automatic archives', () => {
    expect(
      automaticArchiveRefusal({
        ...stewardArchive({ paneKey: 'x', tabId: 'y' }, {}),
        executor: { kind: 'person', via: 'sidebar' }
      } as OrganizationChange)
    ).toBeNull()
  })
})

describe('the last synchronous check before an idle, nothing-pending archive', () => {
  const idle = (): OrganizationChange => ({
    opId: 'op',
    kind: 'archive',
    targets: [{ sessionKey: finished.viewKey }],
    value: true,
    executor: { kind: 'app', feature: 'auto-archive' },
    reason: DONE_ARCHIVE_IDLE_REASON,
    evidence: doneArchiveEvidence(finished.viewKey, clock)
  })

  it('accepts the Done clock token the window wrote for a local row with no plan', () => {
    mocks.rows = [{ ...finished, rowKey: 'row', hostId: 'local' }]
    expect(automaticArchiveRefusal(idle())).toBeNull()
  })

  it('refuses when the clock moved, a plan appeared or the row runs elsewhere', () => {
    mocks.rows = [{ ...finished, rowKey: 'row', hostId: 'local', doneArchivePolicy: null }]
    expect(automaticArchiveRefusal(idle())).toMatch(/Done clock/)
    mocks.rows = [{ ...finished, rowKey: 'row', hostId: 'local' }]
    mocks.chain = { id: 'plan' }
    expect(automaticArchiveRefusal(idle())).toMatch(/plan/)
    mocks.chain = null
    mocks.rows = [{ ...finished, rowKey: 'row', hostId: 'ssh:box' }]
    expect(automaticArchiveRefusal(idle())).toMatch(/elsewhere/)
  })
})
