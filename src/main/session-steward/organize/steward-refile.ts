/**
 * Re-filing (Phase 3 §1): each pass reads JEV's folder fit for idle candidates whose turn changed
 * (or whose reading is a day old), moves a session only when two readings 20 h–3 d apart name the
 * same folder at ≥ 0.8, at most once a day, revision-bound and recorded as `app/steward`; lists
 * the rest as "couldn't place". Nothing moves while re-filing is off, paused, or JEV fails.
 */

import type { SessionBatchOriginsSnapshot } from '../../../shared/session-batch-origin'
import type { SessionFolderEntry } from '../../../shared/session-folder-cli'
import {
  isSessionManageMarkedPrompt,
  type SessionManageActor
} from '../../../shared/session-manage-types'
import {
  organizationTargetKey,
  type OrganizationHistory,
  type OrganizationTarget
} from '../../../shared/session-organization-change'
import type { SessionOrganizePlan, SessionOrganizeResult } from '../../../shared/session-organize'
import type {
  StewardOrganizeFeature,
  StewardOrganizeMode
} from '../../../shared/session-steward-organize-settings'
import { ORGANIZE_NO_REVISION } from '../../session-organization/organization-organize-plan'
import type { StewardAccuracyGuard } from './steward-accuracy-guard'
import {
  readFolderFit,
  type StewardJevDecide,
  type StewardSessionFacts
} from './steward-organize-jev'
import type { StewardFolderReadingRecord, StewardOrganizeState } from './steward-organize-state'
import {
  stewardFolderChoices,
  stewardMayPlace,
  stewardRowMayMove,
  type StewardOrganizeRow
} from './steward-refile-candidates'
import type { StewardSuggestionsStore } from './steward-suggestions-store'

const HOUR_MS = 60 * 60 * 1000
/** JEV's confidence a move (or a new project folder) needs. */
export const STEWARD_REFILE_MIN = 0.8
/** The confirming reading must be this much older than the latest (and at most 3 days). */
export const STEWARD_CONFIRM_MIN_MS = 20 * HOUR_MS
export const STEWARD_CONFIRM_MAX_MS = 72 * HOUR_MS
/** One move per session per day. */
export const STEWARD_MOVE_COOLDOWN_MS = 24 * HOUR_MS
/** A new turn earns a new reading, but not more often than this. */
const NEW_TURN_REREAD_MS = HOUR_MS
/** JEV folder readings per pass, so a large sidebar is read over several passes. */
export const STEWARD_READINGS_PER_PASS = 20

/** The rules loop's own actor: organizing is the steward acting with no person present. */
export const STEWARD_ORGANIZE_ACTOR: SessionManageActor = { kind: 'steward', feature: 'rules' }

export type StewardOrganizeDeps = {
  now: () => number
  rows: () => Promise<StewardOrganizeRow[]>
  folders: () => Promise<SessionFolderEntry[]>
  /** Null when the window cannot say (too old, or none open). */
  batchOrigins: () => Promise<SessionBatchOriginsSnapshot | null>
  history: (key: string) => Promise<OrganizationHistory>
  goal: (observed: StewardOrganizeRow) => Promise<string | null>
  decide: StewardJevDecide
  /** Applies a plan through `organizeSessions` with executor `app/steward`. */
  apply: (plan: SessionOrganizePlan, actor: SessionManageActor) => Promise<SessionOrganizeResult>
  state: StewardOrganizeState
  guard: Pick<StewardAccuracyGuard, 'state' | 'record'>
  suggestions: Pick<StewardSuggestionsStore, 'propose' | 'wasDismissed'>
  /** `stewardOrganizeMode`: off under every steward stop and the JEV stop. */
  mode: (feature: StewardOrganizeFeature) => StewardOrganizeMode
  pairReadsPerDay: () => number
}

export type StewardRefileOutcome = {
  moved: string[]
  unplaced: string[]
  /** Why nothing was read or moved (off, paused, JEV). */
  stopped?: string
}

export function stewardSessionTarget(observed: StewardOrganizeRow): OrganizationTarget {
  const { row } = observed
  return {
    sessionKey: row.viewKey,
    ...(row.paneKey ? { paneKey: row.paneKey } : {}),
    ...(row.tabId ? { tabId: row.tabId } : {})
  }
}

/**
 * The person's own first request to the session, or null: nobody has prompted it yet (an agent
 * started with no prompt), or its first prompt came from another session or the steward.
 */
export async function stewardPersonGoal(
  deps: Pick<StewardOrganizeDeps, 'goal'>,
  observed: StewardOrganizeRow
): Promise<string | null> {
  const goal = (await deps.goal(observed).catch(() => null))?.trim()
  return goal && !isSessionManageMarkedPrompt(goal) ? goal : null
}

export async function stewardSessionFacts(
  deps: Pick<StewardOrganizeDeps, 'goal'>,
  observed: StewardOrganizeRow
): Promise<StewardSessionFacts> {
  const { row } = observed
  return {
    title: row.title,
    goal: await stewardPersonGoal(deps, observed),
    repo: row.repoLabel,
    host: 'This Mac',
    folder: row.folder
  }
}

export function latestRevision(history: Pick<OrganizationHistory, 'entries'>): string {
  return history.entries[0]?.revision ?? ORGANIZE_NO_REVISION
}

/** Records each applied move with the guard, so a person's Undo counts against the feature. */
export async function recordStewardMoves(
  deps: Pick<StewardOrganizeDeps, 'history' | 'guard'>,
  result: SessionOrganizeResult,
  keys: readonly string[]
): Promise<number> {
  let applied = 0
  for (const change of result.changes) {
    if (change.status !== 'applied' || change.kind !== 'move' || !change.opId) {
      continue
    }
    applied += change.panes.length
    for (const key of keys) {
      const record = (await deps.history(key)).entries.find(
        (entry) => entry.opId === change.opId && entry.phase === 'applied'
      )
      if (record) {
        deps.guard.record('refile', record)
        break
      }
    }
  }
  return applied
}

function wantsReading(
  latest: StewardFolderReadingRecord | undefined,
  turnKey: string,
  now: number
): boolean {
  if (!latest) {
    return true
  }
  const age = now - latest.at
  return age >= STEWARD_CONFIRM_MIN_MS || (latest.turnKey !== turnKey && age >= NEW_TURN_REREAD_MS)
}

/** The folder two readings a day apart agree on, or null. */
export function confirmedFolder(readings: readonly StewardFolderReadingRecord[]): string | null {
  const latest = readings.at(-1)
  if (!latest?.folderId || latest.confidence < STEWARD_REFILE_MIN) {
    return null
  }
  const confirmed = readings.some((earlier) => {
    const gap = latest.at - earlier.at
    return (
      earlier.folderId === latest.folderId &&
      earlier.confidence >= STEWARD_REFILE_MIN &&
      gap >= STEWARD_CONFIRM_MIN_MS &&
      gap <= STEWARD_CONFIRM_MAX_MS
    )
  })
  return confirmed ? latest.folderId : null
}

/** Candidates the steward may re-file now, with their ledger history. */
export async function stewardRefileCandidates(
  deps: Pick<StewardOrganizeDeps, 'history' | 'now' | 'goal'>,
  rows: readonly StewardOrganizeRow[]
): Promise<{ observed: StewardOrganizeRow; history: OrganizationHistory }[]> {
  const found: { observed: StewardOrganizeRow; history: OrganizationHistory }[] = []
  for (const observed of rows) {
    if (!stewardRowMayMove(observed)) {
      continue
    }
    // Why: a session nobody has asked anything has no work to file yet.
    if (!(await stewardPersonGoal(deps, observed))) {
      continue
    }
    const history = await deps.history(observed.row.viewKey)
    if (stewardMayPlace(observed.row, history, deps.now())) {
      found.push({ observed, history })
    }
  }
  return found
}

function batchFolderIds(origins: SessionBatchOriginsSnapshot | null): Set<string> {
  return new Set(Object.keys(origins?.folders ?? {}))
}

export async function runStewardRefile(
  deps: StewardOrganizeDeps,
  rows: readonly StewardOrganizeRow[],
  folders: readonly SessionFolderEntry[],
  origins: SessionBatchOriginsSnapshot | null
): Promise<StewardRefileOutcome> {
  const guard = deps.guard.state('refile')
  if (guard.mode !== 'on') {
    return { moved: [], unplaced: [], stopped: `re-filing is ${guard.mode}` }
  }
  const outcome: StewardRefileOutcome = { moved: [], unplaced: [] }
  const batches = batchFolderIds(origins)
  let reads = 0
  for (const { observed, history } of await stewardRefileCandidates(deps, rows)) {
    const key = observed.row.viewKey
    const now = deps.now()
    const turnKey = String(observed.entry.lastActivityAt ?? '')
    const choices = stewardFolderChoices(observed, folders, rows, batches)
    if (wantsReading(deps.state.readings(key).at(-1), turnKey, now)) {
      if (reads >= STEWARD_READINGS_PER_PASS) {
        continue
      }
      reads += 1
      const reading = await readFolderFit(
        await stewardSessionFacts(deps, observed),
        choices,
        deps.decide
      )
      if ('failed' in reading) {
        // Why stop the pass: JEV off or failing moves nothing, and asking again only costs.
        return { ...outcome, stopped: `JEV: ${reading.failed}` }
      }
      deps.state.addReading(key, { ...reading, at: now, turnKey })
    }
    const readings = deps.state.readings(key)
    const folderId = confirmedFolder(readings)
    const lastMove = deps.state.lastMoveAt(key)
    const target = folderId ? choices.find((choice) => choice.id === folderId) : undefined
    if (target && (lastMove === null || now - lastMove >= STEWARD_MOVE_COOLDOWN_MS)) {
      // Why re-ask the guard: an Undo during this pass may have tripped it.
      if (deps.guard.state('refile').mode !== 'on') {
        return { ...outcome, stopped: 're-filing paused' }
      }
      const confidence = readings.at(-1)!.confidence.toFixed(2)
      const result = await deps.apply(
        {
          reason: `JEV folder fit ${confidence}, two readings`,
          changes: [
            {
              pane: observed.row.paneKey!,
              folder: target.path,
              expectedRevision: latestRevision(history)
            }
          ]
        },
        STEWARD_ORGANIZE_ACTOR
      )
      if ((await recordStewardMoves(deps, result, [key])) > 0) {
        deps.state.noteMove(key, now)
        outcome.moved.push(key)
      }
      continue
    }
    const latest = readings.at(-1)
    if (
      observed.row.folderId === null &&
      latest &&
      (latest.folderId === null || latest.confidence < STEWARD_REFILE_MIN)
    ) {
      outcome.unplaced.push(key)
    }
  }
  return outcome
}

/** One "couldn't place" suggestion listing this pass's unfiled sessions (replaces the last). */
export async function proposeUnplaced(
  deps: Pick<StewardOrganizeDeps, 'suggestions'>,
  rows: readonly StewardOrganizeRow[],
  keys: readonly string[]
): Promise<void> {
  const wanted = new Set(keys)
  const targets = rows
    .filter((observed) => wanted.has(observed.row.viewKey))
    .map(stewardSessionTarget)
  if (targets.length === 0) {
    return
  }
  await deps.suggestions.propose({
    kind: 'unplaced',
    targets,
    proposal: { keys: targets.map((target) => organizationTargetKey(target)) },
    title:
      targets.length === 1
        ? '1 session could not be placed in a folder'
        : `${targets.length} sessions could not be placed in a folder`,
    evidence: 'No folder fit at 0.8 or better'
  })
}
