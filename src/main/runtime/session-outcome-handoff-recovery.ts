import { randomUUID } from 'node:crypto'
import {
  SESSION_RECOVERY_BACKOFF_MS,
  SESSION_RECOVERY_DEADLINE_MS,
  SESSION_RECOVERY_MAX_AUTO_RETRIES
} from '../../shared/session-attempt-recovery'
import type {
  SessionFollowUpExceptionCode,
  SessionFollowUpRule
} from '../../shared/session-follow-up-rule'

/**
 * What the host does about a person handoff that did not go out, before anyone is asked anything
 * (`docs/reference/session-run-lifecycle.md`). Pure and clock-injected: the same rule and the same
 * `now` always give the same answer, so the blocker, the sender and the block class cannot disagree.
 */
export type SessionOutcomeHandoffRecovery =
  | { kind: 'none' }
  /** Due now: the sender goes again, with a fresh key only when the hub refused the last one. */
  | { kind: 'resend'; rung: number; rekey: boolean }
  | { kind: 'wait'; rung: number; until: number; code: string }
  | { kind: 'fail'; code: string }

/** Nothing was admitted, or the same key replays: sending again cannot deliver twice. */
const REPLAY_CODES: ReadonlySet<SessionFollowUpExceptionCode> = new Set([
  'unconfirmed',
  'upload-failed',
  'host-unreachable',
  'save-failed'
])

export const SESSION_OUTCOME_HANDOFF_EXHAUSTED_CODE = 'handoff-delivery'

/** Thrown before anything is captured or sent: only the person can sign this host in. */
export const SESSION_OUTCOME_HANDOFF_SIGN_IN =
  'Sign in before committing a person handoff on this host.'

// Records written before `exception.retries` existed carried the count at the end of the detail.
const LEGACY_RESEND_NOTE = / \[automatic resend (\d+) of \d+\]$/

export function sessionOutcomeHandoffResendsUsed(
  rule: Pick<SessionFollowUpRule, 'exception'>
): number {
  if (rule.exception?.retries !== undefined) {
    return rule.exception.retries
  }
  const noted = LEGACY_RESEND_NOTE.exec(rule.exception?.detail ?? '')?.[1]
  return noted ? Number(noted) : 0
}

/** The failure as it rides on the rule: its own words, and what it has already cost in resends. */
export function sessionOutcomeHandoffException(input: {
  code: SessionFollowUpExceptionCode
  subject: string
  message: string
  resends: number
  at: number
}): NonNullable<SessionFollowUpRule['exception']> {
  return {
    code: input.code,
    subject: input.subject,
    detail: input.message.replace(LEGACY_RESEND_NOTE, '').slice(0, 1_900),
    at: input.at,
    ...(input.resends > 0 ? { retries: input.resends } : {})
  }
}

function refusedRecipient(
  rule: SessionFollowUpRule
): { name: string; error?: string; at?: number } | undefined {
  return [...rule.recipients, ...(rule.agentRecipients ?? [])].find(
    (recipient) => recipient.delivery === 'failed'
  )
}

/** The diagnostic a held handoff carries; never what decides its class. */
export function sessionOutcomeHandoffFailureReason(rule: SessionFollowUpRule): string | undefined {
  const exception = rule.exception
  if (exception) {
    return exception.detail || `${exception.code}: ${exception.subject}`
  }
  const refused = refusedRecipient(rule)
  return refused
    ? `The hub refused the handoff to ${refused.name}${refused.error ? `: ${refused.error}` : '.'}`
    : undefined
}

export function decideSessionOutcomeHandoffRecovery(
  rule: SessionFollowUpRule,
  now: number
): SessionOutcomeHandoffRecovery {
  const refused = refusedRecipient(rule)
  // A refused recipient with no exception is a rule an older host (or the renderer) left behind.
  const code = rule.exception?.code ?? (refused ? 'rejected' : undefined)
  if (!code) {
    return { kind: 'none' }
  }
  const rekey = code === 'rejected'
  if (!rekey && !REPLAY_CODES.has(code)) {
    // Packaging the same files again fails the same way, and an unknown stop proves nothing safe.
    return { kind: 'fail', code: `handoff-${code}` }
  }
  const failedAt = rule.exception?.at ?? refused?.at ?? 0
  const used = sessionOutcomeHandoffResendsUsed(rule)
  if (used >= SESSION_RECOVERY_MAX_AUTO_RETRIES || now - failedAt > SESSION_RECOVERY_DEADLINE_MS) {
    return { kind: 'fail', code: SESSION_OUTCOME_HANDOFF_EXHAUSTED_CODE }
  }
  const until =
    failedAt + SESSION_RECOVERY_BACKOFF_MS[Math.min(used, SESSION_RECOVERY_BACKOFF_MS.length - 1)]!
  return now < until
    ? { kind: 'wait', rung: used, until, code: rekey ? 'handoff-rejected' : 'handoff-unconfirmed' }
    : { kind: 'resend', rung: used, rekey }
}

/**
 * A refused request was never admitted, so a fresh key cannot duplicate it; an unconfirmed one keeps
 * its key and replays. The one re-key both the automatic resend and a person's Resume use.
 *
 * The round goes with the person, and a re-ask keeps its thread, so the resend is still round N on
 * the same thread (`isFollowUpReask`). The saved re-ask plan is not kept: it answers only for the
 * refused key, and the delivery prepares a new one for the fresh key from the thread as it is now.
 */
export function rekeyRefusedSessionOutcomeHandoff(
  rule: SessionFollowUpRule,
  mintOperationId: () => string = randomUUID
): SessionFollowUpRule {
  return {
    ...rule,
    ...(rule.agentRecipients?.length
      ? {
          agentRecipients: rule.agentRecipients.map((recipient) =>
            recipient.delivery === 'failed'
              ? {
                  ...recipient,
                  operationId: mintOperationId(),
                  delivery: 'pending' as const,
                  error: undefined
                }
              : recipient
          )
        }
      : {}),
    recipients: rule.recipients.map((recipient) =>
      recipient.delivery === 'failed'
        ? {
            employeeId: recipient.employeeId,
            name: recipient.name,
            operationId: mintOperationId(),
            delivery: 'pending' as const,
            ...(recipient.round ? { round: recipient.round } : {}),
            ...(rule.reask && recipient.threadId ? { threadId: recipient.threadId } : {})
          }
        : recipient
    )
  }
}
