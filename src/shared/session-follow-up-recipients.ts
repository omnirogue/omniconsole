import { normalizeReaskPlan } from './session-follow-up-reask-plan'
import {
  finite,
  matching,
  oneOf,
  record,
  SESSION_FOLLOW_UP_MAX_NAME_CHARS,
  text
} from './session-follow-up-rule-fields'
import type { SessionFollowUpDelivery, SessionFollowUpRecipient } from './session-follow-up-rule'

const EMPLOYEE_ID = /^emp_[A-Za-z0-9_-]{1,120}$/
const OPERATION_ID = /^[A-Za-z0-9_-]{8,160}$/
const THREAD_ID = /^hth_[A-Za-z0-9_-]{1,128}$/
const DELIVERIES: readonly SessionFollowUpDelivery[] = ['pending', 'sending', 'sent', 'failed']

function normalizeRecipient(value: unknown): SessionFollowUpRecipient | null {
  const raw = record(value)
  const employeeId = matching(raw?.employeeId, EMPLOYEE_ID)
  const operationId = matching(raw?.operationId, OPERATION_ID)
  const name = text(raw?.name, SESSION_FOLLOW_UP_MAX_NAME_CHARS)
  if (!raw || !employeeId || !operationId || !name) {
    return null
  }
  const threadId = matching(raw.threadId, THREAD_ID)
  const delivery = oneOf(raw.delivery, DELIVERIES) ?? 'pending'
  const error = text(raw.error, 2000)
  const round = finite(raw.round)
  const reaskPlan = normalizeReaskPlan(raw.reaskPlan)
  const at = finite(raw.at)
  const ownershipTransferredAt = finite(raw.ownershipTransferredAt)
  return {
    employeeId,
    name,
    operationId,
    // Why: `sent` without its thread cannot be shown or reconciled; replaying the same key recovers it.
    delivery: delivery === 'sent' && !threadId ? 'sending' : delivery,
    ...(round !== undefined && Number.isInteger(round) && round > 0 ? { round } : {}),
    ...(reaskPlan ? { reaskPlan } : {}),
    ...(threadId ? { threadId } : {}),
    ...(error ? { error } : {}),
    ...(at !== undefined ? { at } : {}),
    ...(delivery === 'sent' && ownershipTransferredAt !== undefined
      ? { ownershipTransferredAt }
      : {})
  }
}

/** The people of a saved follow-up, as read back from disk: malformed entries and repeats dropped. */
export function normalizeSessionFollowUpRecipients(value: unknown): SessionFollowUpRecipient[] {
  const seen = new Set<string>()
  const recipients: SessionFollowUpRecipient[] = []
  for (const entry of Array.isArray(value) ? value : []) {
    const recipient = normalizeRecipient(entry)
    if (recipient && !seen.has(recipient.employeeId)) {
      seen.add(recipient.employeeId)
      recipients.push(recipient)
    }
  }
  return recipients
}
