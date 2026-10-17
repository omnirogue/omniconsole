/**
 * A new project folder (Phase 3 §1): among sessions the steward could not place, three or more in
 * one repo that JEV reads as the same ongoing project (≥ 0.8 both ways, every pair) get one folder
 * the steward names and creates, recorded as `app/steward`. The steward may rename that folder only
 * until a person renames it (`stewardOwnsFolderName`).
 */

import type { SessionOrganizePlan } from '../../../shared/session-organize'
import type { SessionFolderEntry, SessionFolderOp } from '../../../shared/session-folder-cli'
import { deriveGeneratedTabTitle } from '../../../shared/agent-tab-title'
import {
  isStewardExecutor,
  type OrganizationHistory
} from '../../../shared/session-organization-change'
import { readSameProject } from './steward-organize-jev'
import {
  latestRevision,
  recordStewardMoves,
  STEWARD_ORGANIZE_ACTOR,
  STEWARD_REFILE_MIN,
  stewardSessionFacts,
  type StewardOrganizeDeps
} from './steward-refile'
import type { StewardOrganizeRow } from './steward-refile-candidates'

export const STEWARD_CLUSTER_MIN = 3
/** Sessions read pairwise per repo: 8 is at most 28 pairs, within a day's budget. */
const CLUSTER_SESSIONS_MAX = 8
const FOLDER_NAME_MAX = 60

function pairKey(left: string, right: string): string {
  return `project:${[left, right].toSorted().join('|')}`
}

/** The largest group (≥ 3) where every pair is related; ties go to the first found. */
export function largestRelatedGroup(
  keys: readonly string[],
  related: (left: string, right: string) => boolean
): string[] {
  let best: string[] = []
  for (let mask = 1; mask < 1 << keys.length; mask += 1) {
    const group = keys.filter((_, index) => (mask & (1 << index)) !== 0)
    if (group.length <= best.length || group.length < STEWARD_CLUSTER_MIN) {
      continue
    }
    if (group.every((left, i) => group.slice(i + 1).every((right) => related(left, right)))) {
      best = group
    }
  }
  return best
}

/** "<repo> · <first clause of the earliest goal>", unique among the folders, no path separator. */
export function stewardFolderName(
  repo: string,
  goals: readonly (string | null)[],
  folders: readonly SessionFolderEntry[]
): string {
  const clause = goals.map((goal) => (goal ? deriveGeneratedTabTitle(goal) : null)).find(Boolean)
  const base = (clause ? `${repo} · ${clause}` : repo)
    .replaceAll('/', '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, FOLDER_NAME_MAX)
    .trim()
  const taken = new Set(folders.map((folder) => folder.path.toLowerCase()))
  let name = base
  for (let copy = 2; taken.has(name.toLowerCase()); copy += 1) {
    name = `${base} (${copy})`
  }
  return name
}

async function sameProject(
  deps: StewardOrganizeDeps,
  left: StewardOrganizeRow,
  right: StewardOrganizeRow
): Promise<number | null | 'budget'> {
  const key = pairKey(left.row.viewKey, right.row.viewKey)
  const cached = deps.state.pair(key)
  if (cached !== undefined) {
    return cached
  }
  if (!deps.state.spendPairRead(deps.pairReadsPerDay())) {
    return 'budget'
  }
  const value = await readSameProject(
    await stewardSessionFacts(deps, left),
    await stewardSessionFacts(deps, right),
    deps.decide
  )
  deps.state.notePair(key, value)
  return value
}

/**
 * One new folder per pass for the unplaced sessions of a repo that form a project. Returns the
 * keys it filed; nothing when re-filing is not on, JEV is unsure or the pair budget is spent.
 */
export async function fileStewardCluster(
  deps: StewardOrganizeDeps,
  unplaced: readonly StewardOrganizeRow[],
  folders: readonly SessionFolderEntry[]
): Promise<string[]> {
  const byRepo = new Map<string, StewardOrganizeRow[]>()
  for (const observed of unplaced) {
    const repo = observed.row.repoId
    if (repo) {
      byRepo.set(repo, [...(byRepo.get(repo) ?? []), observed])
    }
  }
  for (const members of byRepo.values()) {
    const sessions = members.slice(0, CLUSTER_SESSIONS_MAX)
    if (sessions.length < STEWARD_CLUSTER_MIN) {
      continue
    }
    const related = new Set<string>()
    for (const [i, left] of sessions.entries()) {
      for (const right of sessions.slice(i + 1)) {
        const value = await sameProject(deps, left, right)
        if (value === 'budget') {
          return []
        }
        if (value !== null && value >= STEWARD_REFILE_MIN) {
          related.add(pairKey(left.row.viewKey, right.row.viewKey))
        }
      }
    }
    const group = largestRelatedGroup(
      sessions.map((observed) => observed.row.viewKey),
      (left, right) => related.has(pairKey(left, right))
    )
    if (group.length === 0) {
      continue
    }
    if (deps.guard.state('refile').mode !== 'on') {
      return []
    }
    const chosen = sessions
      .filter((observed) => group.includes(observed.row.viewKey))
      .toSorted((a, b) => (a.entry.lastActivityAt ?? 0) - (b.entry.lastActivityAt ?? 0))
    const goals = await Promise.all(chosen.map((observed) => deps.goal(observed).catch(() => null)))
    const name = stewardFolderName(chosen[0]!.row.repoLabel ?? 'Project', goals, folders)
    const changes: SessionOrganizePlan['changes'] = []
    for (const observed of chosen) {
      changes.push({
        pane: observed.row.paneKey!,
        folder: name,
        expectedRevision: latestRevision(await deps.history(observed.row.viewKey))
      })
    }
    const result = await deps.apply(
      {
        reason: `JEV: same project (≥ ${STEWARD_REFILE_MIN} both ways), ${chosen.length} sessions`,
        folders: [{ create: name }],
        changes
      },
      STEWARD_ORGANIZE_ACTOR
    )
    const keys = chosen.map((observed) => observed.row.viewKey)
    if ((await recordStewardMoves(deps, result, keys)) === 0) {
      return []
    }
    for (const key of keys) {
      deps.state.noteMove(key, deps.now())
    }
    return keys
  }
  return []
}

/**
 * The steward named this folder and no person has renamed it since: the steward may rename it.
 * `history` is the folder's (`folder:<id>`), newest first.
 */
export function stewardOwnsFolderName(history: Pick<OrganizationHistory, 'entries'>): boolean {
  const applied = history.entries.filter((record) => record.phase === 'applied')
  const created = applied.find((record) => record.kind === 'folder.create')
  if (!created || !isStewardExecutor(created.executor)) {
    return false
  }
  return !applied.some(
    (record) => record.kind === 'folder.rename' && !isStewardExecutor(record.executor)
  )
}

/** Renames a folder the steward still owns the name of; refuses (nothing changed) otherwise. */
export async function renameStewardFolder(
  deps: Pick<StewardOrganizeDeps, 'history'> & {
    mutateFolder: (op: SessionFolderOp, reason: string) => Promise<unknown>
  },
  folder: Pick<SessionFolderEntry, 'id' | 'path'>,
  name: string,
  reason: string
): Promise<void> {
  if (!stewardOwnsFolderName(await deps.history(`folder:${folder.id}`))) {
    throw new Error(`The steward no longer names “${folder.path}”. Nothing changed.`)
  }
  await deps.mutateFolder({ kind: 'renameFolder', folder: folder.path, name }, reason)
}
