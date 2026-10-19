import { describe, expect, it, vi } from 'vitest'
import type { SessionManageEntry, SessionTidyRow } from '../../shared/session-manage-types'
import { applySessionTidy, classifySessionTidyFor, planSessionTidy } from './session-manage-tidy'
import { manageEntry, sidebarRow } from './session-manage-test-fixtures'

const ROW = sidebarRow()
const NOW = 10 * 60 * 60_000
const DELETE = { delete: true, now: NOW }
const DELETE_UNVERIFIED = { delete: true, unverified: true, now: NOW }

function entry(overrides: Partial<SessionManageEntry> = {}): SessionManageEntry {
  return manageEntry({ paneKey: ROW.paneKey, tabId: ROW.tabId, title: ROW.title, ...overrides })
}

const classify = (
  mode: Parameters<typeof classifySessionTidyFor>[0],
  overrides: Partial<SessionManageEntry> = {},
  options: { hold?: string; include?: string[]; row?: Partial<typeof ROW> } = {}
) =>
  classifySessionTidyFor(
    mode,
    { ...ROW, ...options.row },
    entry(overrides),
    options.hold ?? null,
    new Set(options.include ?? [])
  )

describe('session tidy --delete', () => {
  it('deletes what is finished, archived or not', () => {
    expect(classify(DELETE, { state: 'exited', verdict: 'exited' }).action).toBe('delete')
    expect(classify(DELETE)).toMatchObject({ action: 'delete' })
    expect(classify(DELETE, { archived: true })).toMatchObject({
      action: 'delete',
      reason: 'Archived, idle, with nothing pending or waiting.'
    })
  })

  it('keeps what still has value, and says why', () => {
    expect(classify(DELETE, { state: 'working' })).toMatchObject({ action: 'skip', group: 'busy' })
    expect(classify(DELETE, { pinned: true })).toMatchObject({ action: 'skip', group: 'pinned' })
    expect(classify(DELETE, { saved: true, folder: 'Saved Sessions' })).toMatchObject({
      action: 'skip',
      group: 'saved'
    })
    expect(classify(DELETE, { state: 'waiting-for-yes' })).toMatchObject({ group: 'busy' })
    expect(classify(DELETE, { pendingSteps: ['Ship it'] })).toMatchObject({ group: 'open-items' })
    expect(classify(DELETE, {}, { hold: 'Its recorded outcomes are not finished.' })).toMatchObject(
      { action: 'hold', group: 'held' }
    )
    expect(classify(DELETE, {}, { row: { launchPending: true } })).toMatchObject({
      group: 'launch-pending'
    })
  })

  it('lets --include lift any keep except working', () => {
    const include = [ROW.paneKey!]
    for (const overrides of [
      { pinned: true },
      { saved: true },
      { state: 'waiting-for-yes' as const },
      { pendingSteps: ['Ship it'] }
    ]) {
      expect(classify(DELETE, overrides, { include })).toMatchObject({
        action: 'delete',
        included: true
      })
    }
    expect(classify(DELETE, {}, { include, hold: 'Held.' })).toMatchObject({ action: 'delete' })
    expect(classify(DELETE, { state: 'working' }, { include }).action).toBe('skip')
  })

  it('keeps what this computer runs but cannot verify unless the person adds --unverified', () => {
    const cases: [Partial<SessionManageEntry>, Partial<typeof ROW>, string][] = [
      [{ verdict: 'unverifiable', state: 'unknown' }, {}, 'unverifiable'],
      [{ state: 'unknown', verdict: 'live' }, {}, 'unknown-state'],
      [
        { paneKey: null, verdict: 'unverifiable', state: 'unknown' },
        { paneKey: null },
        'unverifiable'
      ]
    ]
    for (const [overrides, row, group] of cases) {
      expect(classify(DELETE, overrides, { row })).toMatchObject({ action: 'skip', group })
      expect(classify(DELETE, overrides, { row }).reason).toContain('--unverified')
      expect(classify(DELETE_UNVERIFIED, overrides, { row })).toMatchObject({
        action: 'delete',
        unverified: true
      })
    }
  })

  it('never deletes what another computer or an SSH host runs, --unverified or named', () => {
    const cases: [Partial<SessionManageEntry>, Partial<typeof ROW>, string][] = [
      [
        { hostId: 'runtime:env-1', verdict: 'unverifiable', state: 'unknown' },
        {},
        'other-omniconsole'
      ],
      [
        { hostId: 'ssh:box', verdict: 'unverifiable' },
        { hostUnavailable: true },
        'host-disconnected'
      ],
      [{ hostId: 'ssh:box' }, {}, 'ssh-host']
    ]
    for (const [overrides, row, group] of cases) {
      const verdict = classify(DELETE_UNVERIFIED, overrides, { row, include: [ROW.paneKey!] })
      expect(verdict).toMatchObject({ action: 'skip', group })
      expect(verdict.reason).toContain('delete it on the computer that runs it')
    }
  })

  it('keeps one it cannot verify that was active in the last hour, unless named', () => {
    const recent = {
      verdict: 'unverifiable' as const,
      state: 'unknown' as const,
      lastActivityAt: NOW - 60_000
    }
    expect(classify(DELETE_UNVERIFIED, recent)).toMatchObject({
      action: 'skip',
      group: 'unverifiable'
    })
    expect(classify(DELETE_UNVERIFIED, recent).reason).toContain('active in the last hour')
    expect(classify(DELETE_UNVERIFIED, recent, { include: [ROW.paneKey!] }).action).toBe('delete')
  })

  it('keeps value before deleting one it cannot verify: a commitment, open steps, a routine', () => {
    const unverifiable = { verdict: 'unverifiable' as const, state: 'unknown' as const }
    expect(classify(DELETE_UNVERIFIED, unverifiable, { hold: 'Held.' }).action).toBe('hold')
    expect(classify(DELETE_UNVERIFIED, { ...unverifiable, pendingSteps: ['Ship'] }).group).toBe(
      'open-items'
    )
    expect(classify(DELETE_UNVERIFIED, unverifiable, { row: { routine: true } }).group).toBe(
      'routine'
    )
    // Its waitingOn says why it is unverifiable, which is not something open.
    expect(
      classify(DELETE_UNVERIFIED, { ...unverifiable, waitingOn: 'No terminal is attached.' }).action
    ).toBe('delete')
  })

  it('keeps a state read from its title alone, named or not', () => {
    expect(classify(DELETE, { stateBasis: 'title' }, { include: [ROW.paneKey!] })).toMatchObject({
      action: 'skip',
      group: 'unknown-state'
    })
  })

  it('still keeps pinned and saved rows it cannot verify', () => {
    const unverifiable = { verdict: 'unverifiable' as const, state: 'unknown' as const }
    expect(classify(DELETE_UNVERIFIED, { ...unverifiable, saved: true }).group).toBe('saved')
    expect(classify(DELETE_UNVERIFIED, { ...unverifiable, pinned: true }).group).toBe('pinned')
  })

  it('names a row with no pane by its tab for --include', () => {
    const tabOnly = { paneKey: null, tabId: 'tab-9', saved: true }
    expect(
      classify(DELETE_UNVERIFIED, tabOnly, { include: ['tab-9'], row: { paneKey: null } })
    ).toMatchObject({ action: 'delete', unverified: true, included: true })
  })

  it('never deletes the session running the cleanup, nor a split in its tab', () => {
    expect(classify({ ...DELETE_UNVERIFIED, selfPaneKey: ROW.paneKey! })).toMatchObject({
      action: 'skip',
      reason: 'This is the session running the cleanup.'
    })
    expect(
      classify({ ...DELETE_UNVERIFIED, selfPaneKey: 'other:leaf', selfTabId: ROW.tabId! }).reason
    ).toContain('shares a tab')
  })

  it("archive mode is unchanged for an agent's session, and holds a person's", () => {
    const agent = { row: { agentSession: true } }
    expect(classify({}, { archived: true }, agent).action).toBe('skip')
    expect(classify({}, {}, agent).action).toBe('archive')
    expect(classify({})).toMatchObject({ action: 'hold', group: 'held' })
    // A person's delete request is theirs: --delete deletes what qualifies, whoever started it.
    expect(classify(DELETE).action).toBe('delete')
  })
})

describe('session tidy --delete plan and apply', () => {
  it('counts deletes and marks the plan as delete mode', () => {
    const plan = planSessionTidy(
      [
        { row: ROW, entry: entry() },
        { row: ROW, entry: entry({ pinned: true }) }
      ],
      () => null,
      new Set(),
      DELETE
    )
    expect(plan.mode).toBe('delete')
    expect(plan.counts).toMatchObject({ delete: 1, skip: 1, archive: 0 })
  })

  it('deletes exactly the delete rows, each re-checked, through the delete path', async () => {
    const rows: SessionTidyRow[] = [
      { ...planRow(), action: 'delete', unverified: true },
      { ...planRow(), paneKey: 'tab-3:leaf-3', action: 'skip', reason: 'Pinned.' },
      { ...planRow(), paneKey: 'tab-4:leaf-4', action: 'delete' }
    ]
    const deleted = vi.fn(async (_row: SessionTidyRow) => ({}))
    const archive = vi.fn(async () => ({}))
    const { rows: out, applied } = await applySessionTidy(rows, {
      recheck: async (row) =>
        row.paneKey === 'tab-4:leaf-4'
          ? { action: 'skip', reason: 'Working.' }
          : { action: 'delete', reason: 'Idle.', unverified: true },
      archive,
      delete: deleted
    })
    expect(archive).not.toHaveBeenCalled()
    expect(deleted).toHaveBeenCalledTimes(1)
    expect(deleted.mock.calls[0]![0]).toMatchObject({ unverified: true })
    expect(applied).toEqual({ archived: 0, deleted: 1, skipped: 1, failed: 0 })
    expect(out.map((row) => row.outcome)).toEqual(['deleted', undefined, 'skipped'])
  })
})

describe('session tidy --delete re-check', () => {
  it('treats a row whose --unverified need changed as changed, never deleting it', async () => {
    const deleted = vi.fn(async (_row: SessionTidyRow) => ({}))
    const { rows: out } = await applySessionTidy([{ ...planRow(), action: 'delete' }], {
      recheck: async () => ({ action: 'delete', reason: 'No terminal.', unverified: true }),
      archive: async () => ({}),
      delete: deleted
    })
    expect(deleted).not.toHaveBeenCalled()
    expect(out[0]).toMatchObject({ outcome: 'skipped' })
  })
})

function planRow(): SessionTidyRow {
  return {
    paneKey: ROW.paneKey,
    tabId: ROW.tabId,
    title: ROW.title,
    folder: null,
    hostId: 'local',
    state: 'idle',
    verdict: 'live',
    action: 'delete',
    reason: 'Idle.'
  }
}
