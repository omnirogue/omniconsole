/**
 * Before the host admits automation it imports what a window (or, for an SSH host, a Mac) holds:
 * values it never recorded are taken as found; a value it recorded differently was changed by
 * something that recorded nothing (an older app, a restored copy), so the found value wins as a
 * restore, which takes an agent's ownership back; and a placement or title with no provenance
 * becomes the person's for good ("anything of unclear origin counts as yours").
 */

import type {
  OrganizationChange,
  OrganizationChangeKind,
  OrganizationExecutor,
  OrganizationOwnershipField
} from '../../shared/session-organization-change'
import {
  HOST_ORGANIZATION_FIELDS,
  type HostOrganizationField,
  type HostOrganizationKind,
  type HostOrganizationMigration,
  type HostOrganizationMigrationResult,
  type HostOrganizationValues
} from '../../shared/session-organization-host'
import { sameOwnedValue } from '../../shared/session-organization-ownership'
import {
  HOST_ORGANIZATION_DEFAULTS,
  hostOrganizationValuesOf,
  type HostOrganizationContext
} from './host-organization-context'

const RESTORE: OrganizationExecutor = { kind: 'app', feature: 'restore' }
const FOUND_EVIDENCE = 'found holding another value than this host recorded'

type Drift = HostOrganizationMigrationResult['drifted'][number]

/** A field's value as the window reads it: an expired snooze is none, tag order does not matter. */
function comparable(field: HostOrganizationField, value: unknown, nowMs: number): unknown {
  if (field === 'snooze') {
    return typeof value === 'number' && value > nowMs ? value : null
  }
  if (field === 'tags') {
    return Array.isArray(value)
      ? [...new Set(value.filter((tag): tag is string => typeof tag === 'string'))].sort()
      : []
  }
  return value ?? HOST_ORGANIZATION_DEFAULTS[field]
}

/** The change that puts a found value back for one target, by the kind that set it. */
export function restoreChangeFor(
  kind: HostOrganizationKind,
  key: string,
  value: unknown,
  found: unknown
): Omit<OrganizationChange, 'opId'> | null {
  const base = { targets: [{ sessionKey: key }], executor: RESTORE, evidence: FOUND_EVIDENCE }
  switch (kind) {
    case 'tag':
    case 'untag':
      return typeof value === 'string'
        ? { ...base, kind: found === true ? 'tag' : 'untag', value }
        : null
    case 'move':
    case 'save':
      return { ...base, kind: 'move', value: found }
    case 'archive':
    case 'unarchive':
      return { ...base, kind: found === true ? 'archive' : 'unarchive', value: found === true }
    case 'hide':
    case 'unhide':
      return { ...base, kind: found === true ? 'hide' : 'unhide', value: found === true }
    case 'title':
    case 'snooze':
      return { ...base, kind, value: found }
  }
}

/** Recorded like every non-person change (prepared first); the fold then holds the found value. */
export async function recordHostRestore(
  context: HostOrganizationContext,
  change: Omit<OrganizationChange, 'opId'>,
  held: unknown,
  found: unknown
): Promise<string | null> {
  const full: OrganizationChange = { ...change, opId: context.mintOpId() }
  try {
    await context.ledger.prepare(full, { before: [held] })
    await context.ledger.settle({ phase: 'applied', change: full, before: [held], after: [found] })
    return full.opId
  } catch (error) {
    console.warn('[session-organization] recording a found value failed', error)
    return null
  }
}

const FIELD_KIND: Record<
  Exclude<HostOrganizationField, 'tags' | 'deleted'>,
  HostOrganizationKind
> = {
  placement: 'move',
  archived: 'archive',
  title: 'title',
  hidden: 'hide',
  snooze: 'snooze'
}

async function restoreField(
  context: HostOrganizationContext,
  key: string,
  field: HostOrganizationField,
  held: unknown,
  found: unknown,
  origin: HostOrganizationValues['titleOrigin']
): Promise<Drift[]> {
  if (field === 'deleted') {
    // Why the window's mark wins: a delete is only ever applied there; this keeps it durably.
    const change: Omit<OrganizationChange, 'opId'> = {
      kind: 'delete',
      targets: [{ sessionKey: key }],
      value: found === true,
      executor: RESTORE,
      evidence: FOUND_EVIDENCE
    }
    const opId = await recordHostRestore(context, change, held, found)
    return opId ? [{ key, field, opId }] : []
  }
  if (field !== 'tags') {
    const change = restoreChangeFor(FIELD_KIND[field], key, found, found)
    const withOrigin = change && field === 'title' && origin ? { ...change, origin } : change
    const opId = withOrigin ? await recordHostRestore(context, withOrigin, held, found) : null
    return opId ? [{ key, field, opId }] : []
  }
  const had = new Set(held as string[])
  const has = new Set(found as string[])
  const flips: [string, boolean][] = [
    ...[...has].filter((tag) => !had.has(tag)).map((tag): [string, boolean] => [tag, true]),
    ...[...had].filter((tag) => !has.has(tag)).map((tag): [string, boolean] => [tag, false])
  ]
  const drift: Drift[] = []
  for (const [tag, on] of flips) {
    const kind: OrganizationChangeKind = on ? 'tag' : 'untag'
    const change = restoreChangeFor(kind, key, tag, on)
    const opId = change ? await recordHostRestore(context, change, !on, on) : null
    if (opId) {
      drift.push({ key, field, opId })
    }
  }
  return drift
}

/** Callers serialize it with every other change. */
export async function migrateHostOrganization(
  context: HostOrganizationContext,
  migration: HostOrganizationMigration
): Promise<HostOrganizationMigrationResult> {
  const { view, ledger } = context
  const at = context.now().toISOString()
  const nowMs = context.now().getTime()
  const drifted: Drift[] = []
  const unknown: { key: string; field: OrganizationOwnershipField }[] = []
  for (const entry of migration.entries) {
    if (entry.digest) {
      view.setDigest(entry.key, entry.digest)
    }
    for (const field of HOST_ORGANIZATION_FIELDS) {
      if (!(field in entry.values)) {
        continue
      }
      const found = comparable(field, entry.values[field], nowMs)
      if (view.entry(entry.key)?.revisions[field] === undefined) {
        // Why: an unrecorded `deleted` already reads false; importing it would only bump revisions.
        if (field === 'deleted' && found !== true) {
          continue
        }
        const origin = field === 'title' ? entry.values.titleOrigin : undefined
        view.importValue(
          entry.key,
          field,
          { [field]: found, ...(origin ? { titleOrigin: origin } : {}) },
          at
        )
        continue
      }
      const held = comparable(field, hostOrganizationValuesOf(context, entry.key)[field], nowMs)
      if (!sameOwnedValue(held, found)) {
        drifted.push(
          ...(await restoreField(context, entry.key, field, held, found, entry.values.titleOrigin))
        )
      }
    }
    const values = hostOrganizationValuesOf(context, entry.key)
    const state = ledger.store.stateFor(entry.key)
    for (const field of ['placement', 'title'] as const) {
      const known =
        state.ownership[field] ||
        state.revocations[field] ||
        (field === 'title' && values.titleOrigin === 'generated')
      if (values[field] !== null && !known) {
        unknown.push({ key: entry.key, field })
      }
    }
  }
  const revocation = { at, opId: `migration:${at}`, why: 'migration/unknown' }
  ledger.store.updateOwnership((states) =>
    states.revoke(unknown.map(({ key, field }) => ({ key, field, revocation })))
  )
  if (migration.complete) {
    view.markMigrated(at)
  }
  return {
    imported: migration.entries.length,
    drifted,
    personOwned: unknown,
    migratedAt: view.migratedAt
  }
}
