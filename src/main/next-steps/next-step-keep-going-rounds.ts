/**
 * One Keep going round, as the host tells it apart from the person: a marked prompt it queued,
 * confirmed delivered by the drain, then the next finished turn after that delivery.
 */

import type { PromptQueueEntry } from '../../shared/prompt-queue-types'

export type KeepGoingRound = {
  marker: string
  /** The queue entry that carries the round; withdrawing it cancels the round. */
  entryId: string
  round: number
  /** The turn whose set this round answered. */
  turnKey: string
  /** Exactly the text queued: the marker, then the suggestion's prompt. */
  sentText: string
  /** Counted into `roundsUsed` once, at the first of: queued, delivered, its turn finished. */
  counted?: boolean
  /** The step's title when it pauses ads (allowed without asking), for the run's record. */
  adPause?: string
}

/** One enablement's in-memory state. Replaced on enable, dropped on stop: its identity is the generation. */
export type RoundTrack = {
  /** Carried by every entry this enablement queues; an entry without it is never ours. */
  runToken: string
  /** Kept, with its cancelling entry id, until a turn after its confirmed delivery matches it. */
  outstanding?: KeepGoingRound
  /** The last turn this enablement has accounted for; a re-report of it is not a new turn. */
  seenTurnKey?: string
  ranTurnKeys: Set<string>
  seenSetIds: Set<string>
  running: boolean
  /** JEV is reading the last finished round; no round starts until it answers. */
  judging?: boolean
  /** The last two reply tails of this run, oldest first (bounded by `rememberReply`). */
  replyTails?: string[]
}

/**
 * The visible prefix of one auto round's prompt. The token is random per round, so a turn that
 * carries it names that round.
 */
export function keepGoingMarker(round: number, maxRounds: number, token: string): string {
  return `[Keep going ${round}/${maxRounds} · kg-${token}] `
}

const collapsed = (text: string): string => text.replace(/\s+/g, ' ').trim()

const MARKER_START = /^\[Keep going \d+\/\d+ · kg-[^\]\s]+\]/

/** A prompt Keep going sent (it starts with a marker): never the person's own words or goal. */
export function isKeepGoingPrompt(text: string | undefined): boolean {
  return MARKER_START.test(collapsed(text ?? ''))
}

/**
 * A finished turn is this round only when the drain confirmed delivering the round's entry, the
 * turn finished after that delivery, and its prompt preview is a prefix of exactly what was sent,
 * whole marker included. A pasted marker in front of other words fails the prefix test.
 */
export function turnIsRound(
  round: KeepGoingRound,
  entry: PromptQueueEntry | undefined,
  turn: { lastUserPrompt?: string; completedAt?: number }
): boolean {
  return turnAnswersDeliveredEntry(round, entry, turn)
}

/**
 * The same proof for any marked entry the host queued (a Keep going round, another session's
 * question): delivered, then a turn after that delivery whose prompt is a prefix of what was sent.
 */
export function turnAnswersDeliveredEntry(
  sent: { marker: string; sentText: string },
  entry: PromptQueueEntry | undefined,
  turn: { lastUserPrompt?: string; completedAt?: number }
): boolean {
  if (entry?.state !== 'delivered' || entry.deliveredAt === undefined) {
    return false
  }
  if (turn.completedAt !== undefined && turn.completedAt < entry.deliveredAt) {
    return false
  }
  const recorded = collapsed(turn.lastUserPrompt ?? '')
  return (
    recorded.length >= collapsed(sent.marker).length &&
    collapsed(sent.sentText).startsWith(recorded)
  )
}

export type TurnRelation = 'newer' | 'same' | 'older' | 'unknown'

/** Only a turn proven newer by the host's own order counts; anything unproven is unknown. */
export function turnRelation(
  current: { turnKey: string; order?: number } | undefined,
  turnKey: string,
  order: number | undefined
): TurnRelation {
  if (current?.turnKey === turnKey) {
    return 'same'
  }
  if (!current || current.order === undefined || order === undefined || order === current.order) {
    return 'unknown'
  }
  return order > current.order ? 'newer' : 'older'
}
