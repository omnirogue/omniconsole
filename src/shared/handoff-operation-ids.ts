import { sha256 } from './sha256'

/**
 * Idempotent operation ids for every hub write a handoff flow makes. The hub keys a thread by
 * `(author, idempotency_key)`, so a retry with the same id replays the same thread instead of
 * minting a second one. Ids must match the contract's `^[A-Za-z0-9_-]{8,160}$`.
 */
const SAFE = /[^A-Za-z0-9_-]/g

function safe(value: string): string {
  return value.replace(SAFE, '_')
}

function bounded(id: string): string {
  if (id.length <= 160) {
    return id
  }
  const digest = Array.from(sha256(new TextEncoder().encode(id)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
  return `${id.slice(0, 95)}_${digest}`
}

function agentStepOperationBase(chainId: string, stepId: string): string {
  return `chain_${safe(chainId)}_step_${safe(stepId)}`
}

/** The fyi thread that mirrors one agent step of a chain into the owner's Waiting for. */
export function agentStepOperationId(chainId: string, stepId: string): string {
  return bounded(agentStepOperationBase(chainId, stepId))
}

/** The `done` entry that resolves that step's thread. */
export function agentStepDoneOperationId(chainId: string, stepId: string): string {
  return bounded(`${agentStepOperationBase(chainId, stepId)}_done`)
}

/** The `reply` entry that reports a failed step (the thread then needs the owner). */
export function agentStepFailedOperationId(
  chainId: string,
  stepId: string,
  attempt: number
): string {
  return bounded(
    `${agentStepOperationBase(chainId, stepId)}_failed_${Math.max(1, Math.trunc(attempt))}`
  )
}

/** A request for someone else's session: one per (session, requester). */
export function sessionRequestOperationId(ledgerId: string, requesterId: string): string {
  return bounded(`request_${safe(ledgerId)}_${safe(requesterId)}`)
}

/** The handoff that answers an accepted request: one per (request thread, recipient). */
export function sessionRequestHandoffOperationId(
  requestThreadId: string,
  recipientId: string
): string {
  return bounded(`request_${safe(requestThreadId)}_handoff_${safe(recipientId)}`)
}

/** The `done` entry on the request thread once the session was handed over. */
export function sessionRequestDoneOperationId(requestThreadId: string): string {
  return bounded(`request_${safe(requestThreadId)}_done`)
}

/** Done on a session with a linked card: one delivery per (card, session) pair. */
export function doneDeliveryOperationId(taskId: string, sessionKey: string): string {
  return bounded(`done_${safe(taskId)}_${safe(sessionKey)}`)
}

export const HANDOFF_OPERATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,160}$/
