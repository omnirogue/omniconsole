/**
 * Provider text that says the account ran out of usage or credit. A transient 429 is not: it is
 * no evidence another account would do better.
 */
const USAGE_LIMIT =
  /hit (?:your |the )?(?:usage )?limit|quota|usage (?:credit|limit)|out of credit|out of extra usage|insufficient (?:credit|balance)|credit balance|credits exhausted|payment required/i

/**
 * Claude Code's plan walls: "You've hit your session limit · resets 1:59pm", "…weekly limit…",
 * "…monthly spend limit…", "You've reached your Fable limit", "…monthly fair-use budget".
 * A context or token ceiling is a different wall another account does not lift.
 */
const PLAN_LIMIT_WALL =
  /\b(?:hit|reached) your (?!(?:[\w-]+ ){0,3}?(?:context|token|output|length|turn|file|size)\b)(?:[\w-]+ ){0,3}(?:limit|budget)\b/i

export function isProviderUsageLimitText(text: string | null | undefined): boolean {
  return !!text && (USAGE_LIMIT.test(text) || PLAN_LIMIT_WALL.test(text))
}
