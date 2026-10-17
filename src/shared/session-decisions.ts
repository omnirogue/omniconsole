/**
 * Work › "Needs You — Questions": the questions sessions on this computer ask the person, kept
 * until they are answered — also when the session dies while waiting — with JEV's Impact / Risk /
 * Effort reading. The question itself is the one `session-questions.ts` reads off the pane's hook
 * status; this adds only durability, the reading, and the order the box shows them in.
 */

import { z } from 'zod'
import type { AgentProviderSessionMetadata } from './agent-session-resume'
import type { AskQuestion } from './native-chat-ask-types'

export const SESSION_DECISIONS_RPC = {
  list: 'sessionDecisions.list',
  /** The box delivered this answer another way (a resumed session's prompt queue). */
  resolve: 'sessionDecisions.resolve',
  /** The person says this one needs no answer (an ended session's question only). */
  dismiss: 'sessionDecisions.dismiss',
  /** What still waits on the person's answer for sessions they are about to delete. */
  answerWaits: 'sessionDecisions.answerWaits'
} as const

export const SessionDecisionsListParamsSchema = z.strictObject({})
export const SessionDecisionKeyParamsSchema = z.strictObject({ key: z.string().min(1).max(400) })

const answerWaitId = z.string().min(1).max(4_096).nullable().optional()
export const SessionAnswerWaitsParamsSchema = z.strictObject({
  sessions: z
    .array(
      z.strictObject({
        paneKey: answerWaitId,
        worktreeId: answerWaitId,
        providerSessionId: answerWaitId
      })
    )
    .max(1_000)
})

/** A session's identity as an answer wait records it: its pane, or the provider conversation. */
export type AnswerWaitSession = z.infer<typeof SessionAnswerWaitsParamsSchema>['sessions'][number]

/** A review page whose decision is not in yet, or an open Question, holding one session. */
export type AnswerWait =
  | { kind: 'review'; slug: string; title: string }
  | { kind: 'question'; key: string }

/** One list of waits per asked session, in the order asked. */
export type SessionAnswerWaitsResult = { waits: AnswerWait[][] }

/** JEV's reading of one decision, each 0–1 (rubric level / 4). Advice only. */
export type DecisionScores = {
  impact: number
  risk: number
  effort: number
  model: string
  at: number
}

/** What main keeps for one asked question until it is answered, dismissed or superseded by its session. */
export type SessionDecisionRecord = {
  key: string
  paneKey: string
  worktreeId: string | null
  agent: string | null
  askedAt: number
  toolUseId: string | null
  toolName: string | null
  /** The raw ask (AskUserQuestion input JSON) exactly as the hook reported it. */
  interactivePrompt: string
  /** The agent's words just before it asked, when the hook carried them (clipped). */
  context: string | null
  providerSession: AgentProviderSessionMetadata | null
  /** The pane's process or terminal went away while this was still unanswered. */
  endedAt: number | null
  scores: DecisionScores | null
  scoreFailure: { reason: string; at: number } | null
  updatedAt: number
}

/** One decision as the Work box lists it. */
export type SessionDecision = Omit<SessionDecisionRecord, 'scoreFailure'> & {
  title: string | null
  questions: AskQuestion[]
  /** Why JEV has no reading yet, in words; null while it is still being asked or has one. */
  scoreUnavailable: string | null
}

export type SessionDecisionsResult = { decisions: SessionDecision[] }

export const SESSION_DECISION_CONTEXT_CHARS = 2_000

/**
 * The order the box offers them in: most value per second first — impact discounted by the effort
 * it takes to decide — and, at equal value, the one that has waited longest. Unscored decisions
 * sit in the middle (0.5 impact, 0.5 effort) so a JEV outage never buries or promotes one.
 */
export function decisionPriority(decision: Pick<SessionDecision, 'scores'>): number {
  const impact = decision.scores?.impact ?? 0.5
  const effort = decision.scores?.effort ?? 0.5
  return impact * (1 - 0.5 * effort)
}

export function orderDecisions<T extends Pick<SessionDecision, 'scores' | 'askedAt' | 'key'>>(
  decisions: readonly T[]
): T[] {
  return decisions.toSorted(
    (left, right) =>
      decisionPriority(right) - decisionPriority(left) ||
      left.askedAt - right.askedAt ||
      left.key.localeCompare(right.key)
  )
}

/** Level of concern a 0–1 reading shows (for color), never a decision by itself. */
export function scoreBand(value: number): 'low' | 'medium' | 'high' {
  return value >= 0.6 ? 'high' : value >= 0.35 ? 'medium' : 'low'
}

/** The text a resumed session receives when the person answers after it died waiting. */
export function answerAfterSessionEnded(questions: readonly AskQuestion[], answer: string): string {
  // Why every question, even an empty one: formatAskAnswer writes exactly one line per question.
  const lines = answer.split('\n')
  const pairs = questions.map((question, index) =>
    `- "${question.question.trim()}" → ${lines[index] ?? ''}`.trimEnd()
  )
  return [
    'You asked me this before your session ended, and I have answered it in OmniConsole:',
    ...pairs,
    'Carry on from where you stopped, using these answers.'
  ].join('\n')
}
