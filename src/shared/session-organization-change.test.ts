import { describe, expect, it } from 'vitest'
import {
  appliedRevision,
  inverseOrganizationKind,
  isOrganizationNoteKind,
  isOrganizationToggleKind,
  isPersonExecutor,
  isStewardExecutor,
  ORGANIZATION_CHANGE_KINDS,
  launchFilingReason,
  mayEstablishOwnership,
  organizationTargetKey,
  organizationValueAt,
  ownershipFieldOf,
  revisionFieldOf,
  revocationFor,
  type OrganizationExecutor,
  type OrganizationRecord
} from './session-organization-change'
import {
  OrganizationChangeSchema,
  OrganizationExecutorSchema
} from './session-organization-change-schema'

function record(
  executor: OrganizationExecutor,
  extra: Partial<OrganizationRecord> = {}
): OrganizationRecord {
  return {
    opId: 'op-1',
    kind: 'move',
    targets: [{ sessionKey: 's1' }],
    value: 'folder-x',
    executor,
    phase: 'applied',
    ts: '2026-09-25T10:00:00.000Z',
    revision: 'op-1',
    ...extra
  }
}

const PANE: OrganizationExecutor = { kind: 'pane', paneKey: 'tab-1:leaf-1', title: 'Ads review' }

describe('organization change contract', () => {
  it('names only the person as a person executor', () => {
    expect(isPersonExecutor({ kind: 'person', via: 'sidebar' })).toBe(true)
    for (const executor of [PANE, { kind: 'cli' }, { kind: 'sync', stamp: 3 }] as const) {
      expect(isPersonExecutor(executor)).toBe(false)
    }
  })

  it('uses the opId as an applied revision, and sync:<stamp> for sync', () => {
    expect(appliedRevision({ opId: 'op-9', executor: PANE })).toBe('op-9')
    expect(appliedRevision({ opId: 'op-9', executor: { kind: 'sync', stamp: 42 } })).toBe('sync:42')
  })

  it('lets only applied, checked, non-person placement or title changes establish ownership', () => {
    expect(mayEstablishOwnership(record(PANE))).toBe(true)
    expect(mayEstablishOwnership(record({ kind: 'launch', source: 'session-prep' }))).toBe(true)
    expect(mayEstablishOwnership(record(PANE, { kind: 'title' }))).toBe(true)
    // Not applied, not checked, or the wrong executor or field: never ownership.
    expect(mayEstablishOwnership(record(PANE, { phase: 'prepared' }))).toBe(false)
    expect(mayEstablishOwnership(record(PANE, { phase: 'failed' }))).toBe(false)
    expect(mayEstablishOwnership(record(PANE, { revisionUnchecked: true }))).toBe(false)
    expect(mayEstablishOwnership(record({ kind: 'person', via: 'sidebar' }))).toBe(false)
    expect(mayEstablishOwnership(record({ kind: 'sync', stamp: 1 }))).toBe(false)
    expect(mayEstablishOwnership(record({ kind: 'app', feature: 'key-migration' }))).toBe(false)
    expect(mayEstablishOwnership(record({ kind: 'app', feature: 'restore' }))).toBe(false)
    expect(mayEstablishOwnership(record(PANE, { kind: 'archive' }))).toBe(false)
  })

  it('lets the steward own a placement it made, never a title (it does not re-title in Phase 2)', () => {
    const steward: OrganizationExecutor = { kind: 'app', feature: 'steward' }
    expect(isStewardExecutor(steward)).toBe(true)
    expect(isStewardExecutor({ kind: 'app', feature: 'auto-archive' })).toBe(false)
    expect(mayEstablishOwnership(record(steward))).toBe(true)
    expect(mayEstablishOwnership(record(steward, { kind: 'title' }))).toBe(false)
  })

  it("revokes the field a person's applied change touched, permanently and with who did it", () => {
    expect(revocationFor(record({ kind: 'person', via: 'sidebar' }))).toEqual({
      field: 'placement',
      revocation: { at: '2026-09-25T10:00:00.000Z', opId: 'op-1', why: 'person/sidebar' }
    })
    expect(
      revocationFor(record({ kind: 'person', via: 'pane-rename' }, { kind: 'title' }))?.field
    ).toBe('title')
    expect(revocationFor(record(PANE))).toBeNull()
    expect(
      revocationFor(record({ kind: 'person', via: 'sidebar' }, { kind: 'archive' }))
    ).toBeNull()
    expect(
      revocationFor(record({ kind: 'person', via: 'sidebar' }, { phase: 'failed' }))
    ).toBeNull()
  })

  it('maps kinds to owned fields, revision fields and inverses', () => {
    expect(ownershipFieldOf('move')).toBe('placement')
    expect(ownershipFieldOf('archive')).toBeNull()
    expect(revisionFieldOf('archive')).toBe(revisionFieldOf('unarchive'))
    expect(revisionFieldOf('folder.reorder')).toBeNull()
    expect(inverseOrganizationKind('archive')).toBe('unarchive')
    expect(inverseOrganizationKind('move')).toBe('move')
    expect(inverseOrganizationKind('folder.delete')).toBeNull()
  })

  it('covers tagging, hiding and snoozing like every other session change', () => {
    expect(ORGANIZATION_CHANGE_KINDS).toEqual(
      expect.arrayContaining(['tag', 'untag', 'hide', 'unhide', 'snooze'])
    )
    expect([inverseOrganizationKind('tag'), inverseOrganizationKind('untag')]).toEqual([
      'untag',
      'tag'
    ])
    expect([inverseOrganizationKind('hide'), inverseOrganizationKind('snooze')]).toEqual([
      'unhide',
      'snooze'
    ])
    expect([revisionFieldOf('tag'), revisionFieldOf('unhide'), revisionFieldOf('snooze')]).toEqual([
      'tags',
      'hidden',
      'snooze'
    ])
    expect(isOrganizationToggleKind('tag')).toBe(true)
    expect(isOrganizationToggleKind('hide')).toBe(false)
    // Only placement and title carry ownership.
    for (const kind of ['tag', 'hide', 'snooze'] as const) {
      expect(ownershipFieldOf(kind)).toBeNull()
      expect(mayEstablishOwnership(record(PANE, { kind }))).toBe(false)
    }
    for (const value of [Date.UTC(2026, 8, 26), null]) {
      expect(
        OrganizationChangeSchema.safeParse({
          opId: 'op',
          kind: 'snooze',
          targets: [{ sessionKey: 's' }],
          value,
          executor: PANE
        }).success
      ).toBe(true)
    }
  })

  it('keeps an archive’s sleep history-only: no caller may record it, and nothing owns or undoes it', () => {
    expect(isOrganizationNoteKind('sleep')).toBe(true)
    expect(isOrganizationNoteKind('archive')).toBe(false)
    expect(ORGANIZATION_CHANGE_KINDS).toContain('sleep')
    expect(
      OrganizationChangeSchema.safeParse({
        opId: 'op',
        kind: 'sleep',
        targets: [{ sessionKey: 's' }],
        value: true,
        executor: { kind: 'app', feature: 'auto-archive' }
      }).success
    ).toBe(false)
    expect(
      OrganizationExecutorSchema.safeParse({ kind: 'app', feature: 'archive-sleep' }).success
    ).toBe(false)
    const note = record({ kind: 'app', feature: 'archive-sleep' }, { kind: 'sleep', value: true })
    expect(ownershipFieldOf('sleep')).toBeNull()
    expect(revisionFieldOf('sleep')).toBeNull()
    expect(inverseOrganizationKind('sleep')).toBeNull()
    expect(mayEstablishOwnership(note)).toBe(false)
    expect(revocationFor(note)).toBeNull()
  })

  it('keys history by session, else folder, pane or tab', () => {
    expect(organizationTargetKey({ sessionKey: 'k', paneKey: 'p' })).toBe('k')
    expect(organizationTargetKey({ folderId: 'f' })).toBe('folder:f')
    expect(organizationTargetKey({ paneKey: 'p', tabId: 't' })).toBe('pane:p')
    expect(organizationTargetKey({ tabId: 't' })).toBe('tab:t')
    expect(organizationTargetKey({})).toBeNull()
  })

  it('reads a per-target value before the shared one', () => {
    expect(organizationValueAt({ value: 'a' }, 3)).toBe('a')
    expect(organizationValueAt({ value: 'a', values: ['x', null] }, 1)).toBeNull()
  })

  it('builds launch filing’s reason from the request, bounded like a batch origin', () => {
    expect(launchFilingReason(undefined)).toBe('filed at launch')
    expect(launchFilingReason('   ')).toBe('filed at launch')
    expect(launchFilingReason('  build the\n checkout page ')).toBe(
      'filed at launch from request "build the checkout page"'
    )
    const long = launchFilingReason('word '.repeat(80))
    expect(long.startsWith('filed at launch from request "word word')).toBe(true)
    expect(long.endsWith('…"')).toBe(true)
    expect(long.length).toBe('filed at launch from request ""'.length + 200)
  })

  it('refuses an executor the contract does not name, such as a steward', () => {
    expect(OrganizationExecutorSchema.safeParse({ kind: 'app', feature: 'steward' }).success).toBe(
      false
    )
    expect(OrganizationExecutorSchema.safeParse({ kind: 'steward' }).success).toBe(false)
    expect(
      OrganizationChangeSchema.safeParse({
        opId: 'op',
        kind: 'move',
        targets: [{ sessionKey: 's' }],
        value: null,
        executor: { kind: 'person', via: 'sidebar' }
      }).success
    ).toBe(true)
  })
})
