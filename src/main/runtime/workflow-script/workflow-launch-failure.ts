import { isCodexAuthError } from '../../../shared/codex-auth-errors'
import { isProviderUsageLimitText } from '../../../shared/provider-usage-limit-text'

/**
 * A call that got no answer because its account could not run it, before any work: every
 * attempt either launched no process, or its process failed on the account (usage limit or
 * sign-in). A graph run may move such a call to another seat once (graph-seat-substitution.ts).
 * Answers that were empty, off-schema or rejected, timeouts and every other failure are not this.
 */
export class WorkflowCallLaunchError extends Error {}

/** How a process failure reads (workflow-native-result.ts) when the provider ended the turn. */
const PROCESS_FAILURE =
  /^workflow (?:process did not complete successfully|provider reported a failed turn|provider did not return a successful result)/

const SIGN_IN =
  /invalid api key|please run \/login|oauth token (?:has )?expired|authentication_error|unauthorized|not logged in/i

/** Whether a failed process's problem is its account's: out of usage, or not signed in. */
export function workflowAccountFailure(problem: string): boolean {
  return (
    PROCESS_FAILURE.test(problem) &&
    (isProviderUsageLimitText(problem) || isCodexAuthError(problem) || SIGN_IN.test(problem))
  )
}

/** A persisted attempt's launch failure, or undefined when it failed any other way (or not at all). */
export function workflowAttemptLaunchFailure(receiptJson: string | null): string | undefined {
  if (!receiptJson) {
    return undefined
  }
  let receipt: { noLaunch?: unknown; reason?: unknown; error?: unknown }
  try {
    receipt = JSON.parse(receiptJson)
  } catch {
    return undefined
  }
  if (receipt.noLaunch === true) {
    return typeof receipt.reason === 'string' ? receipt.reason : 'no process was launched'
  }
  return typeof receipt.error === 'string' && workflowAccountFailure(receipt.error)
    ? receipt.error
    : undefined
}

/** A call's launch failure when every one of its attempts failed at launch; else undefined. */
export function workflowCallLaunchFailure(
  attempts: readonly { state: string; receipt_json: string | null }[]
): string | undefined {
  const reasons = attempts.map((attempt) =>
    attempt.state === 'failed' ? workflowAttemptLaunchFailure(attempt.receipt_json) : undefined
  )
  return reasons.length && reasons.every(Boolean) ? reasons.at(-1) : undefined
}
