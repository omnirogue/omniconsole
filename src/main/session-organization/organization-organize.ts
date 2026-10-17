/**
 * `omni session organize` (and tag/hide/unhide/snooze, which are one-entry plans): a dry run by
 * default; applied, one recorded change per kind with all its targets, one reason and one relay
 * to the window, which applies them in order and shows one notice with one Undo.
 */

import { randomUUID } from 'node:crypto'
import {
  SESSION_FOLDERS_NO_WINDOW_ERROR,
  type SessionFolderEntry,
  type SessionFolderMutationResult,
  type SessionFolderOp
} from '../../shared/session-folder-cli'
import { SAVED_SESSIONS_LABEL } from '../../shared/session-folder-ref'
import type { SessionManageActor } from '../../shared/session-manage-types'
import {
  ORGANIZATION_NO_WINDOW,
  organizationTargetKey,
  type OrganizationChange,
  type OrganizationExecutor
} from '../../shared/session-organization-change'
import type {
  SessionOrganizeChangeReport,
  SessionOrganizePlan,
  SessionOrganizeRelayReply,
  SessionOrganizeResult,
  SessionOrganizeSkip
} from '../../shared/session-organize'
import type { OrganizationChangeLedger } from './organization-change-ledger'
import {
  ORGANIZE_NO_REVISION,
  planOrganize,
  type OrganizeChangeGroup,
  type OrganizeRow
} from './organization-organize-plan'
import type { OrganizationRelay } from './organization-relayed-mutation'
import type { OrganizationAudit } from './organization-trail'

export const ORGANIZE_NEEDS_REASON =
  'Applying an organize plan needs a reason (--reason, or "reason" in the plan): it is recorded with every change so the person can see why. Nothing changed.'

export const ORGANIZE_WINDOW_TOO_OLD =
  'The OmniConsole window cannot apply organize plans yet; update OmniConsole. Nothing changed.'

export type OrganizeDeps = {
  /** Every sidebar row with its observed state. */
  readRows: () => Promise<OrganizeRow[]>
  listFolders: () => Promise<SessionFolderEntry[]>
  /** A recorded folder create or color (`sessionFolders.mutate`). */
  mutateFolder: (op: SessionFolderOp) => Promise<SessionFolderMutationResult>
  ledger: Pick<OrganizationChangeLedger, 'prepare' | 'settle' | 'history'>
  relay: OrganizationRelay
  mintOpId?: () => string
  now?: () => number
}

export type OrganizeInput = {
  plan: SessionOrganizePlan
  apply: boolean
  executor: OrganizationExecutor
  actor: SessionManageActor
  audit?: OrganizationAudit['actor']
}

async function latestRevision(ledger: OrganizeDeps['ledger'], key: string): Promise<string | null> {
  return (await ledger.history(key)).entries[0]?.revision ?? null
}

/** Creates each missing folder of every planned path, parents first, then sets its color. */
async function createFolders(
  planned: SessionOrganizeResult['folders'],
  deps: OrganizeDeps
): Promise<void> {
  for (const folder of planned) {
    try {
      if (folder.status === 'create') {
        const existing = await deps.listFolders()
        const names = folder.path.split(' / ')
        const saved = names[0]?.toLowerCase() === SAVED_SESSIONS_LABEL.toLowerCase()
        for (let depth = saved ? 2 : 1; depth <= names.length; depth += 1) {
          const path = names.slice(0, depth).join(' / ')
          if (existing.some((entry) => entry.path.toLowerCase() === path.toLowerCase())) {
            continue
          }
          const parent = names.slice(0, depth - 1).join(' / ')
          await deps.mutateFolder({
            kind: 'createFolder',
            name: names[depth - 1]!,
            ...(parent && !(saved && depth === 2) ? { parent } : {}),
            ...(saved && depth === 2 ? { saved: true } : {})
          })
        }
        folder.status = 'created'
      }
      if (folder.color !== undefined) {
        await deps.mutateFolder({ kind: 'colorFolder', folder: folder.path, color: folder.color })
      }
    } catch (error) {
      folder.status = 'failed'
      folder.error = error instanceof Error ? error.message : String(error)
    }
  }
}

function toChange(
  group: OrganizeChangeGroup,
  input: OrganizeInput,
  opId: string
): OrganizationChange {
  const uniform = group.values.every(
    (value) => JSON.stringify(value) === JSON.stringify(group.values[0])
  )
  return {
    opId,
    kind: group.kind,
    targets: group.targets,
    value: group.values[0] ?? null,
    ...(uniform ? {} : { values: group.values }),
    executor: input.executor,
    ...(group.origin ? { origin: group.origin } : {}),
    ...(input.plan.reason ? { reason: input.plan.reason } : {}),
    ...(input.plan.request ? { request: input.plan.request } : {})
  }
}

/** Drops targets organized by anyone else since the plan was read, just before applying. */
async function recheck(
  group: OrganizeChangeGroup,
  revisions: Map<string, string>,
  ours: ReadonlySet<string>,
  deps: OrganizeDeps,
  skipped: SessionOrganizeSkip[]
): Promise<OrganizeChangeGroup> {
  const kept: OrganizeChangeGroup = { ...group, targets: [], values: [], panes: [] }
  for (const [index, target] of group.targets.entries()) {
    const key = organizationTargetKey(target)!
    const pane = target.paneKey ?? key
    const now = (await latestRevision(deps.ledger, key)) ?? ORGANIZE_NO_REVISION
    if (now !== revisions.get(pane) && !ours.has(now)) {
      skipped.push({
        pane,
        kind: group.kind,
        reason: `It changed since this plan was read (${now}).`
      })
      continue
    }
    kept.targets.push(target)
    kept.values.push(group.values[index])
    if (!kept.panes.includes(pane)) {
      kept.panes.push(pane)
    }
  }
  return kept
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message === SESSION_FOLDERS_NO_WINDOW_ERROR ? ORGANIZATION_NO_WINDOW : message
}

async function applyGroups(
  input: OrganizeInput,
  groups: OrganizeChangeGroup[],
  revisions: Map<string, string>,
  deps: OrganizeDeps,
  result: SessionOrganizeResult
): Promise<void> {
  const audit = input.audit ? { actor: input.audit } : {}
  const mint = deps.mintOpId ?? randomUUID
  const ours = new Set<string>()
  const prepared: { change: OrganizationChange; report: SessionOrganizeChangeReport }[] = []
  for (const planned of groups) {
    const group = await recheck(planned, revisions, ours, deps, result.skipped)
    if (group.targets.length === 0) {
      continue
    }
    const change = toChange(group, input, mint())
    const report: SessionOrganizeChangeReport = {
      kind: group.kind,
      panes: group.panes,
      opId: change.opId,
      status: 'failed',
      ...(group.origin ? { origin: group.origin } : {})
    }
    result.changes.push(report)
    try {
      await deps.ledger.prepare(change, {
        audit: { ...audit, summary: `session organize: ${group.kind}` }
      })
      ours.add(change.opId)
      prepared.push({ change, report })
    } catch (error) {
      report.error = describe(error)
    }
  }
  if (prepared.length === 0) {
    return
  }
  let reply: SessionOrganizeRelayReply | undefined
  try {
    reply = (await deps.relay({
      kind: 'applyOrganizationChanges',
      changes: prepared.map((entry) => entry.change)
    })) as SessionOrganizeRelayReply | undefined
  } catch (error) {
    for (const { change } of prepared) {
      await deps.ledger.settle({ phase: 'failed', change, error: describe(error) })
    }
    throw error
  }
  // Why: an older window answers a request kind it does not know with nothing, changing nothing.
  if (!Array.isArray(reply?.outcomes)) {
    for (const { change } of prepared) {
      await deps.ledger.settle({ phase: 'failed', change, error: ORGANIZE_WINDOW_TOO_OLD })
    }
    throw new Error(ORGANIZE_WINDOW_TOO_OLD)
  }
  for (const { change, report } of prepared) {
    const outcome = reply.outcomes.find((entry) => entry.opId === change.opId)
    if (!outcome?.ok) {
      report.error = outcome?.error ?? 'The window did not apply it.'
      await deps.ledger.settle({ phase: 'failed', change, error: report.error })
      continue
    }
    const settled = await deps.ledger.settle({
      phase: 'applied',
      change: {
        ...change,
        targets: outcome.targets,
        value: outcome.value,
        ...(outcome.values ? { values: outcome.values } : {})
      },
      ...(outcome.before ? { before: outcome.before } : {}),
      ...(outcome.after ? { after: outcome.after } : {})
    })
    report.status = 'applied'
    if (settled.auditError) {
      result.auditError = settled.auditError
    }
  }
}

export async function organizeSessions(
  input: OrganizeInput,
  deps: OrganizeDeps
): Promise<SessionOrganizeResult> {
  const { plan, apply } = input
  const agent = input.executor.kind === 'pane' || input.executor.kind === 'cli'
  if (apply && agent && !plan.reason?.trim()) {
    throw new Error(ORGANIZE_NEEDS_REASON)
  }
  const [rows, folders] = await Promise.all([deps.readRows(), deps.listFolders()])
  const planned = await planOrganize(plan, {
    rows,
    folders,
    revisionOf: (key) => latestRevision(deps.ledger, key),
    now: (deps.now ?? Date.now)()
  })
  const result: SessionOrganizeResult = {
    dryRun: !apply,
    actor: input.actor,
    ...(plan.reason ? { reason: plan.reason } : {}),
    ...(plan.request ? { request: plan.request } : {}),
    folders: planned.folders,
    changes: [],
    skipped: planned.skipped,
    focus: planned.focus
  }
  if (!apply) {
    result.changes = planned.groups.map((group) => ({
      kind: group.kind,
      panes: group.panes,
      status: 'planned',
      ...(group.origin ? { origin: group.origin } : {})
    }))
    result.plan = {
      ...plan,
      changes: plan.changes.map((entry) => {
        const revision = planned.revisions.get(entry.pane)
        return revision ? { ...entry, expectedRevision: revision } : entry
      })
    }
    return result
  }
  await createFolders(result.folders, deps)
  await applyGroups(input, planned.groups, planned.revisions, deps, result)
  return result
}
