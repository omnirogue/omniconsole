/**
 * Organization records as `session-actions.jsonl` lines: each phase is one line carrying the
 * whole change, so a restart can rebuild the history and find changes a crash interrupted.
 */

import { readFile } from 'node:fs/promises'
import {
  isStewardExecutor,
  type OrganizationChangeKind,
  type OrganizationExecutor,
  type OrganizationRecord,
  type OrganizationTarget
} from '../../shared/session-organization-change'
import type {
  SessionActionActor,
  SessionActionAppend,
  SessionActionAuditActor,
  SessionActionRecord
} from '../session-manage/session-actions-log'

/** The legacy fields of a line: who (as the audit already names them), where, and what it said. */
export type OrganizationAudit = {
  actor?: SessionActionAuditActor
  target?: SessionActionRecord['target']
  summary?: string
  /** The window's own words for where it was and is now (display text). */
  before?: unknown
  after?: unknown
}

export type OrganizationTrailEntry = { record: OrganizationRecord; line: SessionActionRecord }

const AUDIT_ACTIONS: Record<OrganizationChangeKind, SessionActionRecord['action']> = {
  move: 'session.move',
  archive: 'session.archive',
  unarchive: 'session.unarchive',
  delete: 'session.delete',
  title: 'rename',
  save: 'session.save',
  'finish-action': 'session.finish',
  'folder.create': 'folder.create',
  'folder.rename': 'folder.rename',
  'folder.move': 'folder.move',
  'folder.delete': 'folder.delete',
  'folder.color': 'folder.color',
  'folder.reorder': 'folder.reorder',
  'folder.project': 'folder.project',
  tag: 'session.tag',
  untag: 'session.untag',
  hide: 'session.hide',
  unhide: 'session.unhide',
  snooze: 'session.snooze',
  sleep: 'session.sleep'
}

const PHASES = new Set(['prepared', 'applied', 'failed'])

function actorOf(executor: OrganizationExecutor): SessionActionActor {
  if (executor.kind === 'pane') {
    return { paneKey: executor.paneKey, title: executor.title }
  }
  return isStewardExecutor(executor) ? 'steward' : executor.kind
}

function legacyTarget(target: OrganizationTarget | undefined): SessionActionRecord['target'] {
  return {
    ...(target?.paneKey ? { paneKey: target.paneKey } : {}),
    ...(target?.tabId ? { tabId: target.tabId } : {}),
    ...(target?.folderId ? { folder: target.folderId } : {})
  }
}

function defaultSummary(record: OrganizationRecord): string {
  const count = record.targets.length
  return `${record.kind}: ${count} target${count === 1 ? '' : 's'} ${record.phase}`
}

function optional<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as Partial<T>
}

export function organizationTrailLine(
  record: OrganizationRecord,
  audit: OrganizationAudit = {}
): SessionActionAppend {
  return {
    ts: record.ts,
    ...(audit.actor ?? { actor: actorOf(record.executor) }),
    action: AUDIT_ACTIONS[record.kind],
    target: audit.target ?? legacyTarget(record.targets[0]),
    ...(audit.before !== undefined ? { before: audit.before } : {}),
    ...(audit.after !== undefined ? { after: audit.after } : {}),
    summary: audit.summary ?? defaultSummary(record),
    ...optional({
      reason: record.reason,
      request: record.request,
      origin: record.origin,
      revision: record.revision,
      expectedRevision: record.expectedRevision
    }),
    opId: record.opId,
    phase: record.phase,
    executor: record.executor,
    organization: {
      kind: record.kind,
      targets: record.targets,
      value: record.value,
      ...optional({
        values: record.values,
        before: record.before,
        after: record.after,
        evidence: record.evidence,
        undoOf: record.undoOf,
        error: record.error,
        reconciled: record.reconciled,
        revisionUnchecked: record.revisionUnchecked,
        headless: record.headless
      })
    }
  }
}

/** The record one trail line carries; null for a legacy line or one too damaged to trust. */
export function recordFromTrailLine(raw: unknown): OrganizationRecord | null {
  const line = raw as Partial<SessionActionRecord> | null
  const body = line?.organization
  if (
    !line ||
    typeof line.opId !== 'string' ||
    typeof line.ts !== 'string' ||
    !PHASES.has(line.phase as string) ||
    typeof line.executor?.kind !== 'string' ||
    !body ||
    typeof body.kind !== 'string' ||
    !Array.isArray(body.targets)
  ) {
    return null
  }
  return {
    opId: line.opId,
    kind: body.kind,
    targets: body.targets,
    value: body.value,
    executor: line.executor,
    phase: line.phase!,
    ts: line.ts,
    ...optional({
      values: body.values,
      origin: line.origin,
      reason: line.reason,
      request: line.request,
      evidence: body.evidence,
      expectedRevision: line.expectedRevision,
      undoOf: body.undoOf,
      before: body.before,
      after: body.after,
      revision: line.revision,
      error: body.error,
      reconciled: body.reconciled,
      revisionUnchecked: body.revisionUnchecked,
      headless: body.headless === true ? (true as const) : undefined
    })
  }
}

/** Every organization line in the rotated file and the current one, oldest first. */
export async function readOrganizationTrail(path: string): Promise<OrganizationTrailEntry[]> {
  const entries: OrganizationTrailEntry[] = []
  for (const file of [`${path}.1`, path]) {
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      continue
    }
    for (const raw of text.split('\n')) {
      if (!raw.includes('"opId"')) {
        continue
      }
      let line: unknown
      try {
        line = JSON.parse(raw)
      } catch {
        continue
      }
      const record = recordFromTrailLine(line)
      if (record) {
        entries.push({ record, line: line as SessionActionRecord })
      }
    }
  }
  return entries
}
