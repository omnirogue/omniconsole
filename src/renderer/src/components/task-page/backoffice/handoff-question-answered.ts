import { create } from 'zustand'
import {
  DECISION_KINDS,
  type WorkRow,
  type WorkViews
} from '../../../../../shared/backoffice-work-views'

/**
 * How long Work hides a question answered here before it trusts the next read again. Why: the
 * console caches the to-do list for 10 s and is not told about this write, and Work rereads it
 * at most once a minute, so a read right after the answer can still list the question.
 */
export const ANSWERED_QUESTION_HIDE_MS = 2 * 60_000

export const useAnsweredHandoffQuestions = create<{ ids: ReadonlyMap<string, number> }>(() => ({
  ids: new Map()
}))

export function markHandoffQuestionAnswered(decisionId: string, now = Date.now()): void {
  const ids = new Map(
    [...useAnsweredHandoffQuestions.getState().ids].filter(
      ([, at]) => now - at < ANSWERED_QUESTION_HIDE_MS
    )
  )
  ids.set(decisionId, now)
  useAnsweredHandoffQuestions.setState({ ids })
}

/**
 * The views without the questions answered here moments ago. Why after the projection: a
 * question's row carries its handoff thread, so they leave together; dropping the Todo row
 * before it would let the cached thread stand in Needs you on its own.
 */
export function withoutAnsweredQuestions(
  views: WorkViews,
  ids: ReadonlyMap<string, number>,
  now = Date.now()
): WorkViews {
  if (ids.size === 0) {
    return views
  }
  const answered = (row: WorkRow): boolean => {
    const decisionId = row.todo?.decision_id
    const at = decisionId ? ids.get(decisionId) : undefined
    return at !== undefined && now - at < ANSWERED_QUESTION_HIDE_MS
  }
  if (!views.all.some(answered)) {
    return views
  }
  const needsYou = views.needsYou.filter((row) => !answered(row))
  const waitingFor = views.waitingFor.filter((row) => !answered(row))
  return {
    ...views,
    needsYou,
    waitingFor,
    all: views.all.filter((row) => !answered(row)),
    counts: {
      needsYou: needsYou.length,
      decisions: needsYou.filter((row) => DECISION_KINDS.has(row.kind)).length,
      waitingFor: waitingFor.length
    }
  }
}
