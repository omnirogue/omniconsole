import type { AgentDotState } from '@/components/AgentStateDot'
import type { SessionActionPresetId } from '../../../shared/session-action-presets'
import type { SessionTeamMember } from './session-team-summary'

/**
 * The plan's seats folded into the rows a person reads: a fan-out is one row whose seats
 * launch together, a review round is one row of reviewers, rounds of one action are one
 * row with a round counter, and everything else is one seat after another. The same fold
 * serves the preview before Go and the live view after it, so the rows never move.
 */
export type SessionTeamPhaseKind = 'work' | 'review' | 'repair' | 'workers' | 'subagents'

export type SessionTeamPhase = {
  key: string
  kind: SessionTeamPhaseKind
  /** The seats launch together after the same source. */
  parallel: boolean
  /** The one action every seat performs, when they share one. */
  action: SessionActionPresetId | null
  /** A review round, or the rounds of one repeated action. */
  round: { index: number; total: number } | null
  members: SessionTeamMember[]
}

export type SessionTeamProgress = {
  total: number
  planned: number
  live: number
  done: number
  /** Seats that will never run: failed, cancelled or skipped. */
  off: number
  failed: number
}

const OFF_STATES = new Set<SessionTeamMember['state']>(['skipped', 'cancelled', 'failed'])

function phaseKind(member: SessionTeamMember): SessionTeamPhaseKind {
  switch (member.role) {
    case 'reviewer':
      return 'review'
    case 'repair':
      return 'repair'
    case 'subagent':
      return 'subagents'
    case 'coordinator':
    case 'worker':
      if (member.key.startsWith('pane:')) {
        return 'workers'
      }
      // Why: a judge or reviewer seat added as an action is a review row, whatever the runtime calls it.
      return member.action === 'review' || member.action === 'verify' ? 'review' : 'work'
    case 'producer':
      return 'work'
  }
}

/** Seats that belong on one row: same fan-out, same review round, or live helpers of one kind. */
function sharesRow(previous: SessionTeamMember, next: SessionTeamMember): boolean {
  // Why: a fan-out is one row whatever its seats do; the group launched them together.
  if (previous.group || next.group) {
    return previous.group === next.group
  }
  const kind = phaseKind(previous)
  if (kind !== phaseKind(next)) {
    return false
  }
  if (kind === 'workers' || kind === 'subagents') {
    return true
  }
  if (kind === 'review') {
    return previous.round?.index === next.round?.index
  }
  // Why: rounds of one action are the same seat repeated; the row shows "↻ 2/3", not three rows.
  return Boolean(
    previous.round &&
    next.round &&
    previous.round.total === next.round.total &&
    next.round.index === previous.round.index + 1 &&
    previous.agent === next.agent &&
    (previous.action ?? null) === (next.action ?? null)
  )
}

function sharedAction(members: readonly SessionTeamMember[]): SessionActionPresetId | null {
  const actions = new Set(members.map((member) => member.action ?? null))
  const [only] = [...actions]
  return actions.size === 1 && only ? only : null
}

function phaseRound(
  kind: SessionTeamPhaseKind,
  members: readonly SessionTeamMember[]
): SessionTeamPhase['round'] {
  const first = members[0]?.round ?? null
  if (!first) {
    return null
  }
  if (kind === 'review' || members.length === 1) {
    return { index: first.index, total: first.total }
  }
  // Why: sequential rounds fold into one row; the counter names the round that is under way.
  const current =
    members.find((member) => member.state !== 'done' && !OFF_STATES.has(member.state)) ??
    members.at(-1)
  return { index: current?.round?.index ?? first.index, total: first.total }
}

export function sessionTeamPhases(members: readonly SessionTeamMember[]): SessionTeamPhase[] {
  const rows: SessionTeamMember[][] = []
  for (const member of members) {
    const row = rows.at(-1)
    if (row && sharesRow(row.at(-1)!, member)) {
      row.push(member)
    } else {
      rows.push([member])
    }
  }
  return rows.map((row, index) => {
    const kinds = new Set(row.map(phaseKind))
    const kind = kinds.size === 1 ? phaseKind(row[0]!) : 'work'
    const rounds = row.length > 1 && !row[0]!.group && kind !== 'review'
    return {
      key: `${index}:${row[0]!.key}`,
      kind,
      parallel: row.length > 1 && !rounds,
      action: sharedAction(row),
      round: phaseRound(kind, row),
      members: row
    }
  })
}

export function sessionTeamProgress(members: readonly SessionTeamMember[]): SessionTeamProgress {
  const progress: SessionTeamProgress = {
    total: 0,
    planned: 0,
    live: 0,
    done: 0,
    off: 0,
    failed: 0
  }
  for (const member of members) {
    progress.total += 1
    if (member.state === 'planned') {
      progress.planned += 1
    } else if (member.state === 'done') {
      progress.done += 1
    } else if (OFF_STATES.has(member.state)) {
      progress.off += 1
      if (member.state === 'failed') {
        progress.failed += 1
      }
    } else {
      progress.live += 1
    }
  }
  return progress
}

/** The shared state glyph for a seat; a planned seat is the quiet dot, never a spinner. */
export function sessionTeamMemberDot(state: SessionTeamMember['state']): AgentDotState {
  switch (state) {
    case 'working':
      return 'working'
    case 'blocked':
      return 'blocked'
    case 'waiting':
      return 'waiting'
    case 'done':
      return 'done'
    case 'failed':
      return 'failed'
    case 'planned':
    case 'idle':
    case 'skipped':
    case 'cancelled':
      return 'idle'
  }
}
