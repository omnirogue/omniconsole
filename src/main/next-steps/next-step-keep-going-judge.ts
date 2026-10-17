/**
 * Keep going's JEV stops, read after each finished round: "done" (both modes) and, for "Push for
 * better", "another round is not making it better". Both readings are injected and optional; an
 * unsure, missing, late or failed reading never stops anything.
 */

import type { ConversationSource } from '../../shared/conversation-source'
import {
  nextStepLooksDone,
  nextStepPushIsSpent,
  type NextStepDoneness,
  type NextStepImprovementVerdict
} from '../../shared/next-step-doneness'
import type { KeepGoingCore } from './next-step-keep-going-core'
import type { RoundTrack } from './next-step-keep-going-rounds'

export type NextStepKeepGoingDonenessInput = {
  conversation: ConversationSource
  turnKey: string
  /** The tail of the reply that finished the round. */
  reply: string
}

export type NextStepKeepGoingImprovementInput = {
  conversation: ConversationSource
  turnKey: string
  /** The tail of the reply before this round, and of this round's reply. */
  previous: string
  latest: string
  /** What the person asked each round. */
  pushPrompt: string
}

export type NextStepKeepGoingJudges = {
  assessDoneness?: (input: NextStepKeepGoingDonenessInput) => Promise<NextStepDoneness | null>
  judgeImprovement?: (
    input: NextStepKeepGoingImprovementInput
  ) => Promise<NextStepImprovementVerdict | null>
  /** A reading slower than this counts as none; default 90 s. */
  judgeTimeoutMs?: number
}

export const KEEP_GOING_REPLY_TAIL_CHARS = 6000
const DEFAULT_JUDGE_TIMEOUT_MS = 90_000

export const replyTail = (text: string | undefined): string =>
  (text ?? '').trim().slice(-KEEP_GOING_REPLY_TAIL_CHARS)

/**
 * Keeps the last two reply tails of this run, the pair "Push for better" compares. An empty reply
 * is kept too, so the pair is always this round and the one before (an empty one is never judged).
 */
export function rememberReply(track: RoundTrack, reply: string | undefined): void {
  track.replyTails = [...(track.replyTails ?? []), replyTail(reply)].slice(-2)
}

export function hasJudges(judges: NextStepKeepGoingJudges): boolean {
  return Boolean(judges.assessDoneness || judges.judgeImprovement)
}

function bounded<T>(read: (() => Promise<T | null>) | null, timeoutMs: number): Promise<T | null> {
  if (!read) {
    return Promise.resolve(null)
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs)
  })
  const reading = Promise.resolve()
    .then(read)
    .catch((error: unknown) => {
      console.warn('[next-steps] keep going: a JEV reading failed', error)
      return null
    })
  return Promise.race([reading, late]).finally(() => clearTimeout(timer))
}

/**
 * Holds the next round (`track.judging`) while the readings are taken, then stops Keep going when
 * they are clear, or hands back to `resume`. A run stopped or replaced meanwhile is left alone.
 */
export async function judgeFinishedRound(
  core: KeepGoingCore,
  key: string,
  track: RoundTrack,
  turnKey: string,
  resume: () => void
): Promise<void> {
  const state = core.deps.store.get(key)
  const judges = core.deps
  if (!state?.enabled || !hasJudges(judges)) {
    resume()
    return
  }
  const push = state.mode === 'push-for-better'
  const [previous, latest] =
    track.replyTails && track.replyTails.length >= 2 ? track.replyTails : [undefined, undefined]
  const { conversation } = state
  const timeout = judges.judgeTimeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS
  const assess = judges.assessDoneness
  const judge = judges.judgeImprovement
  track.judging = true
  // Neither reading rejects: a failure or a timeout is null.
  const [reading, verdict] = await Promise.all([
    bounded(
      assess
        ? () => assess({ conversation, turnKey, reply: track.replyTails?.at(-1) ?? '' })
        : null,
      timeout
    ),
    bounded(
      push && judge && previous && latest
        ? () =>
            judge({ conversation, turnKey, previous, latest, pushPrompt: state.pushPrompt ?? '' })
        : null,
      timeout
    )
  ])
  track.judging = false
  const current = core.deps.store.get(key)
  if (core.tracks.get(key) !== track || !current?.enabled) {
    return
  }
  // A reading of another turn is not a reading of this one.
  const own = reading?.turnKey === turnKey ? reading : null
  const done = nextStepLooksDone(own)
  const stopDone = () => core.stop(key, 'done', undefined, Math.round(own!.resolved * 100))
  if (current.mode === 'push-for-better') {
    // Finished work is where pushing starts: only no room left, or a round that did not help, ends it.
    if (!nextStepPushIsSpent(own, verdict)) {
      resume()
    } else if (done) {
      stopDone()
    } else {
      core.stop(key, 'no-more-improvement')
    }
  } else if (done) {
    stopDone()
  } else {
    resume()
  }
}
