/**
 * Goal-tracking titles (Phase 3 §2). An idle session is re-titled when its goal moved on: a new
 * pull-request goal, a task card attached or changed, or two finished turns in a row that JEV reads
 * as off the goal (≤ 0.2), or a fresh compact summary offers a name. JEV picks among that name,
 * the PR title, the card title, the agent's own title, the latest
 * instruction's first clause and "keep", and only a pick at ≥ 0.6 changes it. Only a title the app
 * or a launch generated (never revoked by a person) changes, revision-bound, never while the session
 * works and never within an hour of any other title change. JEV off or unsure changes nothing.
 */

import { deriveGeneratedTabTitle } from '../../../shared/agent-tab-title'
import type { OrganizationHistory } from '../../../shared/session-organization-change'
import {
  sessionOwnerEligibility,
  sessionOwnerLoad
} from '../../session-manage/session-manage-owner-load'
import type { StewardGoalMemory } from './steward-organize-state'
import { stewardPersonGoal, type StewardOrganizeDeps } from './steward-refile'
import type { StewardOrganizeRow } from './steward-refile-candidates'
import { chooseStewardTitle, readStillOnGoal, STEWARD_TITLE_MIN } from './steward-retitle-jev'

const HOUR_MS = 60 * 60 * 1000
/** After any title change the title is left alone this long. */
export const STEWARD_TITLE_COOLDOWN_MS = HOUR_MS
/** Session readings per pass (each can ask GitHub, the console and JEV). */
export const STEWARD_GOAL_READS_PER_PASS = 10
/** "Still on goal" at or below this, twice in a row, is drift. */
export const STEWARD_DRIFT_MAX = 0.2

/** The goal a session is pursuing now: the last of its pull-request goals. */
export type StewardSessionGoal = {
  key: string
  /** Its position among the session's goals, oldest first. */
  index: number
  title: string
  /** "PR #12 opened", for the change's reason. */
  cause: string
}

export type StewardTitleReading = {
  goal: StewardSessionGoal | null
  /** The latest finished turn; null while one is unfinished or unreadable. */
  turn: { key: string; text: string } | null
  instruction: string | null
  card: { key: string; title: string } | null
  summaryTitle?: string | null
  /** The agent's own title for the session (Claude's ai-title, Codex's thread name). */
  aiTitle?: string | null
}

export type StewardRetitleDeps = {
  /** Read cached titles in one batch; no inference and no transcript scan. */
  summaryTitles?: (rows: readonly StewardOrganizeRow[]) => Promise<ReadonlyMap<string, string>>
  titleReading: (observed: StewardOrganizeRow) => Promise<StewardTitleReading | null>
  /** Applies the title as `app/steward`, origin `generated`; the applied change's opId, or null. */
  retitle: (
    observed: StewardOrganizeRow,
    title: string,
    change: { reason: string; expectedRevision?: string }
  ) => Promise<string | null>
}

/** A proven generated title the person never changed: the only kind the steward re-titles. */
export function stewardTitleIsGenerated(
  history: Pick<OrganizationHistory, 'entries' | 'ownership' | 'revocations'>
): boolean {
  const owner = history.ownership.title
  if (history.revocations.title || !owner || (owner.by !== 'app' && owner.by !== 'launch')) {
    return false
  }
  const established = history.entries.find((record) => record.opId === owner.opId)
  return established?.origin === 'generated' && latestTitle(history)?.origin === 'generated'
}

function latestTitle(history: Pick<OrganizationHistory, 'entries'>) {
  return history.entries.find((record) => record.kind === 'title' && record.phase === 'applied')
}

/** Nothing pending and no title change in the last hour; later passes try again. */
function titleSettled(history: Pick<OrganizationHistory, 'entries' | 'pending'>, now: number) {
  const latest = latestTitle(history)
  return (
    history.pending.length === 0 &&
    (!latest || now - Date.parse(latest.ts) >= STEWARD_TITLE_COOLDOWN_MS)
  )
}

function idleHere(observed: StewardOrganizeRow): boolean {
  return (
    sessionOwnerEligibility(observed, new Set()).eligible &&
    sessionOwnerLoad(observed.entry, observed.bound).light &&
    !observed.row.archived
  )
}

function sameTitle(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase()
}

/** What moved on since the last reading (the change's reason), and the drift readings now. */
async function readTrigger(
  deps: StewardOrganizeDeps,
  aim: string,
  reading: StewardTitleReading,
  memory: StewardGoalMemory | undefined
): Promise<{ reason: string | null; drift: StewardGoalMemory['drift'] }> {
  const { goal, card, turn } = reading
  let drift = memory?.drift ?? []
  if (reading.summaryTitle && reading.summaryTitle !== memory?.summaryTitle) {
    return { reason: 'compact summary describes the current work', drift }
  }
  if (turn && !drift.some((entry) => entry.turnKey === turn.key)) {
    const score = await readStillOnGoal(aim, turn.text, deps.decide)
    if (score !== null) {
      drift = [...drift, { turnKey: turn.key, score }].slice(-2)
    }
  }
  // Why the position: a PR GitHub cannot answer for hides the newest goal; that is not a change.
  if (goal && memory?.goalKey && goal.key !== memory.goalKey && goal.index > memory.index) {
    return { reason: `goal changed: ${goal.cause}`, drift }
  }
  // Why a known card memory: a card seen on the first reading is learned, not a change.
  if (card && memory && memory.cardKey !== undefined && card.key !== memory.cardKey) {
    return { reason: `task card: ${card.title}`, drift }
  }
  if (drift.length === 2 && drift.every((entry) => entry.score <= STEWARD_DRIFT_MAX)) {
    return { reason: 'two finished turns moved off the goal', drift }
  }
  return { reason: null, drift }
}

function candidates(reading: StewardTitleReading, current: string): string[] {
  const found = [
    reading.summaryTitle,
    reading.goal?.title,
    reading.card?.title,
    reading.aiTitle,
    reading.instruction ? deriveGeneratedTabTitle(reading.instruction) : null
  ].filter((title): title is string => Boolean(title?.trim()) && !sameTitle(title!, current))
  return [...new Set(found)]
}

export async function runStewardRetitle(
  deps: StewardOrganizeDeps & StewardRetitleDeps,
  rows: readonly StewardOrganizeRow[]
): Promise<{ retitled: string[]; stopped?: string }> {
  const guard = deps.guard.state('retitle')
  if (guard.mode !== 'on') {
    return { retitled: [], stopped: `re-titling is ${guard.mode}` }
  }
  const retitled: string[] = []
  const summaryTitles = await deps
    .summaryTitles?.(rows.filter(idleHere))
    .catch(() => new Map<string, string>())
  let reads = 0
  for (const observed of rows) {
    const key = observed.row.viewKey
    const turnKey = String(observed.entry.lastActivityAt ?? '')
    const memory = deps.state.goal(key)
    const summaryTitle = summaryTitles?.get(key) ?? null
    // Why only idle: a working session's turn is unfinished, and its title never moves then.
    if (
      !idleHere(observed) ||
      (memory?.turnKey === turnKey && (!summaryTitle || summaryTitle === memory.summaryTitle))
    ) {
      continue
    }
    // Why: a session nobody has asked anything has no goal for a title to follow.
    const aim = await stewardPersonGoal(deps, observed)
    if (!aim) {
      continue
    }
    if (reads >= STEWARD_GOAL_READS_PER_PASS) {
      break
    }
    reads += 1
    const source = await deps.titleReading(observed).catch(() => null)
    if (!source) {
      continue
    }
    const reading = { ...source, summaryTitle }
    const { reason, drift } = await readTrigger(deps, aim, reading, memory)
    // A goal that only reads older (a PR GitHub could not answer for) keeps the one remembered.
    const older = Boolean(reading.goal && memory && reading.goal.index < memory.index)
    const learned: Omit<StewardGoalMemory, 'at'> = {
      goalKey: (older ? null : reading.goal?.key) ?? memory?.goalKey ?? null,
      index: Math.max(reading.goal?.index ?? -1, memory?.index ?? -1),
      turnKey,
      cardKey: reading.card?.key ?? null,
      summaryTitle,
      drift
    }
    const history = reason ? await deps.history(key) : null
    if (!reason || !history || !stewardTitleIsGenerated(history)) {
      deps.state.noteGoal(key, learned)
      continue
    }
    if (!titleSettled(history, deps.now()) || deps.guard.state('retitle').mode !== 'on') {
      // Why keep the old memory: the trigger is tried again next pass, its drift readings kept.
      deps.state.noteGoal(
        key,
        memory ? { ...memory, drift } : { ...learned, summaryTitle: null, turnKey: '' }
      )
      continue
    }
    const options = candidates(reading, observed.row.title)
    const choice =
      options.length > 0
        ? await chooseStewardTitle(
            {
              current: observed.row.title,
              candidates: options,
              goal: aim,
              instruction: reading.instruction,
              turn: reading.turn?.text ?? null
            },
            deps.decide
          )
        : null
    // Handled either way: a trigger is acted on once, and drift starts over.
    deps.state.noteGoal(key, { ...learned, drift: [] })
    if (!choice || 'failed' in choice || !choice.title || choice.confidence < STEWARD_TITLE_MIN) {
      continue
    }
    const revision = latestTitle(history)?.revision
    const opId = await deps.retitle(observed, choice.title, {
      reason,
      ...(revision ? { expectedRevision: revision } : {})
    })
    const record = opId
      ? (await deps.history(key)).entries.find(
          (entry) => entry.opId === opId && entry.phase === 'applied'
        )
      : undefined
    if (record) {
      deps.guard.record('retitle', record)
      retitled.push(key)
    }
  }
  return { retitled }
}
