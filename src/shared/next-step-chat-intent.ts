import { isKnownHarnessInjectedUserTurnText } from './harness-injected-user-turns'
import { hasNextOutcomeDiscovery } from './next-outcome-intent-instructions'
import { hasNextOutcomeWaitRequest } from './next-outcome-wait-request'

// Why: a typed next-step instruction is short; past this point the prompt is a paste, and
// every pattern below stays linear in what it scans.
const SCAN_LIMIT = 32_000

/**
 * The tag a person types when they mean it: "@next review with codex, then send to
 * Kimi, then give it to @uma". Everything below this line is inference about
 * phrasing; this is a statement. It wins on its own, anywhere in the message, so
 * nobody has to learn which wording the patterns happen to recognise.
 */
const NEXT_STEP_TAG = /(?:^|[\s(["'])@next\b/i

/** Explicit next-step phrasing only; ordinary work requests ("please review this code") stay out. */
const NEXT_STEP_CHAT_PATTERNS: readonly RegExp[] = [
  // "add a Codex reviewer", "add another reviewer", "add 2 reviewers"
  /\badd (?:(?:a|an|another|one|two|three|\d+|some|more) )?(?:[\w.-]+ )?reviewers?\b/i,
  // "hand off … to Uma", "hand it off to Sal", "handoff to" — the recipient must follow in the same sentence
  /\bhands?(?: (?:it|this|that|them|the [\w-]+))? ?off\b[^.!?\n]{0,200}?\bto\b/i,
  // "give this/it/the files/the work to <name>"
  /\bgive (?:this|it|that|them|the (?:files?|work|results?|deliverables?|repo|branch|pr)) to\b/i,
  // "mark this complete", "mark it as done", "mark this session as saved"
  /\bmark (?:(?:this|it|that|(?:(?:this|that|the|my) )?(?:session|task|work|card)) )?(?:as )?(?:complete|completed|done|finished|saved)\b/i,
  // "save this session", "end session", "close the session"
  /\b(?:save|end|close) (?:(?:this|the|my) )?session\b/i
]

/**
 * "reviewed by codex", "review by Uma" — an explicit statement, not a question. A deadline
 * ("review by Friday", "review by 5pm") is work to do now; "does the reviewer get reviewed by
 * the judge too?" asks about one, so it must never file either (y).
 */
const REVIEW_BY =
  /\breview(?:ed)? by (?:(?:a|an|the) )?(?!(?:mon|tues|wednes|thurs|fri|satur|sun)day\b|tomorrow\b|tonight\b|today\b|noon\b|midnight\b|eod\b|eow\b|end\b|next\b|\d)[\w@.-]+/i

/** "Does/do/did … get reviewed by …" is asking whether a review happens, not asking for one. */
const REVIEW_BY_QUESTION = /\b(?:does|do|did)\b[^.!?\n]{0,60}\bget\b[^.!?\n]{0,20}\breview/i

function hasReviewByIntent(head: string): boolean {
  return REVIEW_BY.test(head) && !REVIEW_BY_QUESTION.test(head)
}

/**
 * "when you are done" / "after this is done" on its own is not a next step: "when done, run the
 * tests" is work to do now. It counts only with a next-step consequent somewhere in the message.
 */
const FINISH_CLAUSE =
  /\b(?:when (?:(?:you(?:'re| are)|it(?:'s| is)|its|this is|that is|that's|everything is) )?(?:all )?(?:done|finished|complete)|after (?:this|that|it)(?:'s| is)? ?(?:done|finished|complete))\b/i

/** Consequents that make a finish clause a next step: a handoff, a notification, a session fate. */
const FINISH_CONSEQUENTS: readonly RegExp[] = [
  /\bhands?(?: (?:it|this|that|them|the [\w-]+))? ?off\b/i,
  /\bhand(?:off|over)\b/i,
  /\b(?:ping|notify|tell|message|dm|email|slack|alert) (?:me|us|him|her|them|[A-Z][\w-]+)\b/,
  /\blet (?:me|us|him|her|them|[A-Z][\w-]+) know\b/,
  /\bsend (?:(?:it|this|that|them|everything|the [\w-]+) )?to\b/i,
  /\b(?:complete|finish|close|end|wrap up) (?:(?:this|the|my) )?(?:session|task|card)\b/i
]

function hasFinishClauseWithConsequent(head: string): boolean {
  return FINISH_CLAUSE.test(head) && FINISH_CONSEQUENTS.some((pattern) => pattern.test(head))
}

/**
 * True when a submitted chat message reads as "what happens next" (reviewers, handoff,
 * completion, session fate) rather than work to do now. Harness-injected turns and
 * launch prompts already carrying the outcome discovery marker never match.
 *
 * The commit admission gate reads this to refuse an unattested AI commit from an ordinary
 * prompt, and the prompt hook reads it to point the agent at `outcome context`
 * (`next-step-chat-hook-reply.ts`): plans come from conversation again (Sal, 2026-09-24).
 */
export function isNextStepChatIntent(prompt: string): boolean {
  const text = prompt.trim()
  if (!text || isKnownHarnessInjectedUserTurnText(text) || hasNextOutcomeDiscovery(text)) {
    return false
  }
  const head = text.slice(0, SCAN_LIMIT)
  return (
    NEXT_STEP_TAG.test(head) ||
    NEXT_STEP_CHAT_PATTERNS.some((pattern) => pattern.test(head)) ||
    hasReviewByIntent(head) ||
    hasFinishClauseWithConsequent(head) ||
    hasNextOutcomeWaitRequest(head)
  )
}
