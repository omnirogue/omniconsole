/**
 * JEV's questions behind `session find-owner`: does this task continue that session's goal, and
 * is it the very same deliverable (asked in both orders, the lower answer kept, so the position of
 * the two texts cannot decide a duplicate)? Unsure or unavailable is never related or duplicate.
 */

import type { DecisionRequest, DecisionResult } from '../../shared/structured-decisions'
import { jevDecide, type JevRankOptions } from '../structured-decisions/jev-rank'
import { fitJevText } from '../structured-decisions/jev-rank-rubric'
import { TYPESAFE_DEFAULT_MODEL } from '../structured-decisions/typesafe-provider'

export const SESSION_OWNER_JEV_CAPABILITY = 'sessions.find-owner'
export const SESSION_OWNER_SUMMARY_MAX_CHARS = 1_200

export const SESSION_OWNER_CONTINUATION_QUESTION =
  "Is the first (a new task) a natural continuation of the second (a session's goal) — same deliverable/project, not a different job?"

/** Both orders name their two texts by position; the state carries them in that order. */
export const SESSION_OWNER_DUPLICATE_QUESTION =
  'Do the first and the second describe the SAME deliverable, so doing both would duplicate the work (not merely the same project, a follow-up, or a different part of it)?'

export type SessionOwnerJevSession = { title: string; goal: string | null; summary: string | null }
export type SessionOwnerJudgement = { related: number; duplicate: number | null }

function describeSession(session: SessionOwnerJevSession): string {
  const summary = session.summary?.trim()
  return fitJevText(
    [
      `Title: ${session.title}`,
      `Goal (the person's first request to it): ${session.goal?.trim() || 'unknown'}`,
      ...(summary ? [`Summary so far: ${summary.slice(0, SESSION_OWNER_SUMMARY_MAX_CHARS)}`] : [])
    ].join('\n'),
    4_000
  )
}

/** Task first: the continuation question, and the duplicate question in this order. */
export function buildSessionOwnerJevRequest(
  task: string,
  session: SessionOwnerJevSession
): DecisionRequest {
  return {
    capability: SESSION_OWNER_JEV_CAPABILITY,
    model: TYPESAFE_DEFAULT_MODEL,
    state: { first: fitJevText(task.trim(), 8_000), second: describeSession(session) },
    questions: {
      continuation: { type: 'noul', instructions: SESSION_OWNER_CONTINUATION_QUESTION },
      duplicate: { type: 'noul', instructions: SESSION_OWNER_DUPLICATE_QUESTION }
    }
  }
}

/** The session first: the duplicate question with the two texts swapped. */
export function buildSessionOwnerSwappedRequest(
  task: string,
  session: SessionOwnerJevSession
): DecisionRequest {
  return {
    capability: SESSION_OWNER_JEV_CAPABILITY,
    model: TYPESAFE_DEFAULT_MODEL,
    state: { first: describeSession(session), second: fitJevText(task.trim(), 8_000) },
    questions: { duplicate: { type: 'noul', instructions: SESSION_OWNER_DUPLICATE_QUESTION } }
  }
}

function noul(result: DecisionResult | { failed: string }, id: string): number | null {
  if ('failed' in result) {
    return null
  }
  const answer = result.answers[id]
  return answer?.type === 'noul' && Number.isFinite(answer.noul) ? answer.noul : null
}

export async function judgeSessionOwner(
  task: string,
  session: SessionOwnerJevSession,
  options: JevRankOptions = {}
): Promise<SessionOwnerJudgement | { failed: string }> {
  const jev = { ...options, caller: 'session-owner' }
  const [first, swapped] = await Promise.all([
    jevDecide(buildSessionOwnerJevRequest(task, session), jev),
    jevDecide(buildSessionOwnerSwappedRequest(task, session), jev)
  ])
  const related = noul(first, 'continuation')
  if (related === null) {
    return 'failed' in first ? first : { failed: 'JEV did not answer the continuation question' }
  }
  const ordered = noul(first, 'duplicate')
  const reversed = noul(swapped, 'duplicate')
  // Why null when one order is missing: a duplicate must hold in both orders.
  return {
    related,
    duplicate: ordered === null || reversed === null ? null : Math.min(ordered, reversed)
  }
}
