/**
 * A session still waiting on the person's answer: a review page it armed (its decision is not in
 * yet) or a Question it asked that is still open. Cleanup never closes or deletes such a session;
 * only the person can delete one by hand (Sal's page 1a12bf204b7a4bd1d, item 4).
 */

import type {
  AnswerWait,
  AnswerWaitSession,
  SessionDecisionRecord
} from '../../shared/session-decisions'
import {
  listReviewSleepEntries,
  type ReviewSleepEntry
} from '../artifacts/artifact-review-sleep-targets'
import { getProfileUserDataPath } from '../omni-profiles/profile-storage-paths'
import { getSessionDecisionStore } from '../session-questions/session-decision-wiring'

export type { AnswerWait, AnswerWaitSession }

type QuestionRecord = Pick<SessionDecisionRecord, 'key' | 'paneKey' | 'providerSession'>

/** Same open states the Decisions list shows; awake/moved/deleted no longer hold this session. */
const OPEN_REVIEW_STATES: ReadonlySet<string> = new Set(['waiting', 'asleep', 'waking', 'stalled'])

/** Armed and undecided: a current reading that no longer needs the person means decided or closed. */
export function isOpenReviewWait(
  entry: Pick<ReviewSleepEntry, 'sleep' | 'reviewAttention'>
): boolean {
  const attention = entry.reviewAttention
  const decided = !!attention && attention.revision >= entry.sleep.revision && !attention.needsYou
  return OPEN_REVIEW_STATES.has(entry.sleep.state) && !decided
}

function samePane(
  session: AnswerWaitSession,
  paneKey: string,
  worktreeId?: string | null
): boolean {
  return (
    !!session.paneKey &&
    session.paneKey === paneKey &&
    (!session.worktreeId || !worktreeId || session.worktreeId === worktreeId)
  )
}

/** The waits that hold this session, by its pane or by the provider conversation it carries. */
export function openAnswerWaits(
  session: AnswerWaitSession,
  reviews: readonly ReviewSleepEntry[],
  questions: readonly QuestionRecord[]
): AnswerWait[] {
  const conversation = session.providerSessionId || null
  const waits: AnswerWait[] = []
  for (const entry of reviews) {
    const { paneKey, worktreeId, nativeSessionId } = entry.sourceReview
    if (
      isOpenReviewWait(entry) &&
      (samePane(session, paneKey, worktreeId) || conversation === nativeSessionId)
    ) {
      waits.push({ kind: 'review', slug: entry.slug, title: entry.title || entry.slug })
    }
  }
  for (const record of questions) {
    if (
      samePane(session, record.paneKey) ||
      (!!conversation && conversation === record.providerSession?.id)
    ) {
      waits.push({ kind: 'question', key: record.key })
    }
  }
  return waits
}

function firstReview(waits: readonly AnswerWait[]): Extract<AnswerWait, { kind: 'review' }> | null {
  return waits.find((wait) => wait.kind === 'review') ?? null
}

/** Why cleanup keeps it, in plain words; null when nothing waits on the person. */
export function answerWaitReason(waits: readonly AnswerWait[]): string | null {
  const review = firstReview(waits)
  return review
    ? `Kept: waiting on your decision (${review.title}).`
    : waits.length
      ? 'Kept: waiting on your answer to a Question.'
      : null
}

/** The refusal an agent's delete or close gets; only the person deletes such a session. */
export function answerWaitDeleteRefusal(waits: readonly AnswerWait[]): string | null {
  if (!waits.length) {
    return null
  }
  const review = firstReview(waits)
  const what = review
    ? `a decision is still waiting on this session (${review.title})`
    : 'this session is still waiting on your answer to a Question'
  return `Kept: ${what}; only the person can delete it. Nothing changed.`
}

/** Open Questions only, for a close whose review waits have their own wake-proven release. */
export function hasOpenQuestion(session: AnswerWaitSession): boolean {
  return openAnswerWaits(session, [], getSessionDecisionStore()?.list() ?? []).length > 0
}

/** One read of this computer's open waits, then a lookup per session. A failed read throws. */
export function readAnswerWaits(
  apiOrigin: string | null,
  userDataPath = getProfileUserDataPath()
): (session: AnswerWaitSession) => AnswerWait[] {
  const reviews = listReviewSleepEntries(apiOrigin, userDataPath).filter(isOpenReviewWait)
  const questions = getSessionDecisionStore()?.list() ?? []
  return (session) => openAnswerWaits(session, reviews, questions)
}

const UNREADABLE_REASON =
  'Kept: whether a decision or a Question waits on it could not be read; unknown means keep.'

/** Cleanup's keep reason per session, read once; unreadable waits keep every session. */
export function answerWaitKeeper(
  apiOrigin: string | null,
  userDataPath = getProfileUserDataPath()
): (session: AnswerWaitSession) => string | null {
  try {
    const waits = readAnswerWaits(apiOrigin, userDataPath)
    return (session) => answerWaitReason(waits(session))
  } catch {
    return () => UNREADABLE_REASON
  }
}

/** An agent's delete of one session: refused while the person's answer is open, or unreadable. */
export function agentAnswerWaitRefusal(
  apiOrigin: string | null,
  session: AnswerWaitSession,
  userDataPath = getProfileUserDataPath()
): string | null {
  try {
    return answerWaitDeleteRefusal(readAnswerWaits(apiOrigin, userDataPath)(session))
  } catch {
    return `${UNREADABLE_REASON} Only the person can delete it. Nothing changed.`
  }
}
