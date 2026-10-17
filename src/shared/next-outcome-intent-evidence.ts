import type { SessionOutcomeCondition } from './session-outcome-types'
import { nextOutcomeIntent } from './next-outcome-intent'
import type { ResolvedNextOutcomeHandoff } from './next-outcome-handoff-request'
import type { ResolvedNextOutcomeWait } from './next-outcome-wait-request'
import { nextOutcomeWaitEvidenced } from './next-outcome-wait-evidence'

/** Match supported evidence categories; this never grants authority for the action. */
export function assertNextOutcomeIntentEvidence(
  instructions: string,
  conditions: readonly SessionOutcomeCondition[]
): void {
  const intent = nextOutcomeIntent(instructions)
  if (intent.kind !== 'unsupported') {
    return
  }
  // A wait on Slack, email or Jira reads those destinations; it publishes nothing to them.
  if (
    conditions.some((condition) => condition.kind === 'event') &&
    !/\b(publish|upload|release|re-release|deploy|push|refund|purchase|merge)\b|\b(drive|youtube|dropbox|s3|sharepoint)\b/i.test(
      instructions
    )
  ) {
    return
  }
  const urls = instructions.match(/https?:\/\/[^\s"'`<>]+/g) ?? []
  const executableReceipt = conditions.some(
    (condition) =>
      (condition.kind === 'command' || condition.kind === 'deployment') &&
      condition.verification &&
      urls.every((url) => condition.target.includes(url))
  )
  if (executableReceipt) {
    return
  }
  if (
    /\b(publish|upload|release|re-release|deploy|push|refund|purchase)\b|\b(drive|youtube|dropbox|s3|sharepoint)\b/i.test(
      instructions
    )
  ) {
    throw new Error(intent.reason)
  }
  if (
    /\bmerge\b/i.test(instructions) &&
    conditions.some((condition) => condition.kind === 'merge')
  ) {
    return
  }
  if (
    /\b(send|email)\b/i.test(instructions) &&
    conditions.some((condition) => condition.kind === 'handoff' && condition.recipientId)
  ) {
    return
  }
  throw new Error(intent.reason)
}

// Publication authority still requires a user-authored condition; people require host-resolved requests.
const SELF_GRANTABLE_ESCALATION: ReadonlySet<SessionOutcomeCondition['kind']> = new Set([
  'merge',
  'pr',
  'deployment',
  'handoff'
])

/** Whether the attested source prompt itself asks for what an escalated condition binds; never authority by itself. */
export function nextOutcomeEscalationEvidenced(
  condition: SessionOutcomeCondition,
  prompt: string,
  handoffs: readonly ResolvedNextOutcomeHandoff[] = [],
  waits: readonly ResolvedNextOutcomeWait[] = []
): boolean {
  if (condition.kind === 'event') {
    return nextOutcomeWaitEvidenced(condition, prompt, waits)
  }
  const kind = condition.kind === 'review' && condition.recipientId ? 'handoff' : condition.kind
  if (kind === 'handoff') {
    return (
      !condition.recipientSessionId &&
      handoffs.some(
        (request) =>
          request.person.id === condition.recipientId &&
          condition.target === request.person.id &&
          prompt.includes(request.instruction) &&
          (condition.kind !== 'review' || request.review)
      )
    )
  }
  return !SELF_GRANTABLE_ESCALATION.has(kind)
}
