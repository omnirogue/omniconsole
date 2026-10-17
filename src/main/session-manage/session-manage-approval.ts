/**
 * Whether a free `continue --prompt` reads as an approval ("yes", "go ahead", "do it", "2", "both").
 * Only a hint: such a prompt is refused and pointed at `--yes`/`--choose`. Safety never rests on
 * this list; `session-manage-freeform.ts` refuses a free prompt near anything a hard stop covers.
 */

export type ContextualApproval = (
  | { kind: 'yes' }
  | { kind: 'choose'; choice: number }
  | { kind: 'all' }
) & {
  /** Nothing but the approval, or words that only point back at the proposal ("with it"). */
  bare: boolean
}

// Longest first, so "go ahead" is taken before "go".
const APPROVALS = [
  'sounds good to me',
  "let's do that",
  "let's do it",
  'lets do it',
  'sounds good',
  'looks good',
  'that works',
  'go for it',
  'make it so',
  'please do',
  'yes please',
  'all right',
  'go ahead',
  'carry on',
  'keep going',
  'ship it',
  "let's go",
  'do that',
  'do it',
  'do so',
  'affirmative',
  'confirmed',
  'approved',
  'proceed',
  'continue',
  'alright',
  'confirm',
  'approve',
  'correct',
  'agreed',
  'yeah',
  'sure',
  'okay',
  'lgtm',
  'yep',
  'yup',
  'yes',
  'go',
  'ok',
  'k',
  'y',
  '👍'
]
// Words that also open an ordinary instruction ("go fix the tests", "ok, run it"): alone they
// approve, followed by words of their own they do not.
const INSTRUCTION_OPENERS = new Set([
  'go',
  'continue',
  'proceed',
  'carry on',
  'keep going',
  'ok',
  'okay',
  'sure',
  'k',
  'y',
  'alright',
  'all right'
])
const ORDINALS: Record<string, number> = {
  one: 1,
  first: 1,
  two: 2,
  second: 2,
  three: 3,
  third: 3,
  four: 4,
  fourth: 4,
  five: 5,
  fifth: 5
}
const CHOICE_RE =
  /^(?:(?:go|going|let's go|do|pick|choose|take|use|run|with|the|option|choice|number|#)\s*)*(\d{1,2}|one|two|three|four|five|first|second|third|fourth|fifth)(?:st|nd|rd|th)?(?:\s+(?:one|option|step))?$/
const ALL_RE = /^(?:do\s+|with\s+)?(?:all|both|everything|all of them|both of them|all three|each)$/
const POINTS_BACK_RE =
  /^(?:(?:with|on|and|to)\s+)?(?:it|that|this|them|those|the plan|your plan|the proposal|your proposal|what you (?:said|suggested|proposed|offered)|as (?:planned|proposed|suggested)|the (?:next|suggested|proposed) steps?|your suggestions?|the suggestions?)?$/

function normalized(text: string): string {
  return text
    .toLowerCase()
    .replace(/’/g, "'")
    .replace(/[“”"]/g, '')
    .replace(/[.!?,;:()]+/g, ' ')
    .replace(/\b(?:please|pls|thanks|thank you|then|now)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The approval a freeform prompt makes of the target's own proposal, or null when it makes none. */
export function contextualApprovalOf(text: string): ContextualApproval | null {
  let rest = normalized(text)
  let matched = false
  let strong = false
  for (let taken = true; taken && rest;) {
    taken = false
    for (const word of APPROVALS) {
      if (rest === word || rest.startsWith(`${word} `)) {
        rest = rest.slice(word.length).trim()
        matched = taken = true
        strong ||= !INSTRUCTION_OPENERS.has(word)
        break
      }
    }
  }
  const choice = CHOICE_RE.exec(rest)
  if (choice) {
    const value = choice[1]!
    return { kind: 'choose', choice: ORDINALS[value] ?? Number(value), bare: true }
  }
  if (ALL_RE.test(rest)) {
    return { kind: 'all', bare: true }
  }
  const bare = POINTS_BACK_RE.test(rest)
  // Why a strong opener counts even with more words: "yes, and add tests" still says yes.
  return matched && (strong || bare) ? { kind: 'yes', bare } : null
}
