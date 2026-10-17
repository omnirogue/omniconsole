import { detectSessionPrepRequest } from './session-prep-intent'

const TASK_VERB =
  /^(?:audit|build|compare|create|draft|find|fix|implement|investigate|prepare|research|review|test|write)\b/i
const GOAL_PREFIX =
  /^(?:(?:please\s+)?(?:I want|I need|I would like|I'd like) you to\s+|(?:new task|new objective|my objective|my goal)\s*:\s*)/i
const LOCAL_METHOD =
  /(?:\bagent:|\b(?:in|within) this (?:conversation|session)|\b(?:do|handle|keep|work on) (?:this|it) here\b|\b(?:do not|don't|no) (?:route|dispatch|delegate|new sessions?)\b)/i
const FOLLOW_UP =
  /^(?:continue|resume|retry|again|also|now|instead|actually|yes|no|stop|cancel|undo|change|update|make it)\b/i

export function hasConversationalGoalPrefix(text: string): boolean {
  return GOAL_PREFIX.test(text.trim())
}

/** Only a new, self-contained human objective; existing task follow-ups stay with their owner. */
export function detectConversationalDispatchRequest(
  text: string,
  context: string,
  enabled = true
): { request: string } | null {
  const request = text.trim()
  if (LOCAL_METHOD.test(request)) {
    return null
  }
  const explicit = detectSessionPrepRequest(text)
  if (explicit) {
    return explicit
  }
  if (!enabled || !request || /^[>\x60/]/.test(request) || LOCAL_METHOD.test(request)) {
    return null
  }
  const goal = GOAL_PREFIX.exec(request)
  const ask = goal
    ? request.slice(goal[0].length)
    : request.replace(/^(?:please|can you|could you)\s+/i, '')
  if (FOLLOW_UP.test(ask) || !TASK_VERB.test(ask)) {
    return null
  }
  if ((ask.match(/[\p{L}\p{N}_]+/gu)?.length ?? 0) < 6) {
    return null
  }
  if (/\b(?:this|that|it|above|earlier|same)\b/i.test(ask)) {
    return null
  }
  // Goal wording can still be a follow-up; ongoing work needs explicit dispatch syntax.
  if (context.trim()) {
    return null
  }
  return { request }
}
