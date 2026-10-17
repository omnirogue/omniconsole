/**
 * One atomic unit of input for an agent session.
 *
 * Every caller — chat composer, chain step launch, orchestration worker — hands
 * the WHOLE sequence (clear the line, write the framed body, submit) to the
 * host's session input queue as a single item. Nothing is left behind as a
 * caller-side timer, so a target that changes owner mid-send cannot receive a
 * late Enter from the sequence that owned it before.
 */

import { getTerminalInputByteLength, TERMINAL_INPUT_MAX_BYTES } from './terminal-input'

export type SessionInputOrigin = 'chat' | 'chain' | 'worker'

export type SessionInputStep =
  /** Bytes to hand the PTY as one write. */
  | { kind: 'write'; data: string }
  /** Gap the TUI needs before the next write (paste-end before Enter, key pacing). */
  | { kind: 'pause'; ms: number }
  /**
   * Clear-then-look: wait `afterMs` and widen to `widenTo` unless the clear is
   * observed to have landed. The host cannot read the client's input line, so an
   * unobserved clear widens — the same branch the client took when its own probe
   * threw, and an overshooting clear burst is a measured no-op on an empty line.
   */
  | { kind: 'clear-confirm'; afterMs: number; widenTo: string }

export type SessionInputProgram = {
  steps: SessionInputStep[]
}

export type SessionInputSubmission = {
  /** Session identity: the PTY the host already keys agent prompt ordering by. */
  ptyId: string
  clientMessageId: string
  origin: SessionInputOrigin
  /** Dedupe subject — the prompt text, not the framed bytes. */
  body: string
  /** A deliberate repeat: clears the identical-body window, never the id ledger. */
  force?: boolean
  program: SessionInputProgram
}

export type SessionInputStatus =
  | 'delivered'
  /** Same clientMessageId inside the TTL; the first delivery stands, nothing was written. */
  | 'already-delivered'
  /** Identical body from the same origin inside the window and no force flag. */
  | 'duplicate-rejected'
  /** The session rebound, exited, or the caller cancelled: zero further bytes. */
  | 'cancelled'
  | 'failed'

export type SessionInputCancelReason = 'rebound' | 'session-exited' | 'caller-cancelled'

export type SessionInputReceipt = {
  clientMessageId: string
  status: SessionInputStatus
  /** Preserved failure classification, e.g. `agent_prompt_stalled`. */
  errorCode?: string
  errorMessage?: string
  reason?: SessionInputCancelReason
}

/** How long a delivered clientMessageId replays as already-delivered. */
export const SESSION_INPUT_IDEMPOTENCY_TTL_MS = 5 * 60_000

/** An identical body from the same origin inside this window needs `force`. */
export const SESSION_INPUT_DUPLICATE_BODY_WINDOW_MS = 2_000

/** Bounds on a submitted program so one item cannot hold a session open. */
export const SESSION_INPUT_MAX_STEPS = 16
export const SESSION_INPUT_MAX_PAUSE_MS = 10_000
export const SESSION_INPUT_MAX_TOTAL_PAUSE_MS = 30_000

export function isSessionInputDeliveredStatus(status: SessionInputStatus): boolean {
  return status === 'delivered' || status === 'already-delivered'
}

/**
 * Build the atomic program for a clear → body → submit sequence.
 * `submitRetry` covers agents that render their composer before Enter is live.
 */
export function buildSessionInputProgram(parts: {
  clearInput?: string
  clearConfirm?: { afterMs: number; widenTo: string }
  body: string
  submitDelayMs: number
  submit: string
  submitRetry?: { delayMs: number; data: string }
}): SessionInputProgram {
  const steps: SessionInputStep[] = []
  if (parts.clearInput) {
    steps.push({ kind: 'write', data: parts.clearInput })
  }
  if (parts.clearConfirm) {
    steps.push({ kind: 'clear-confirm', ...parts.clearConfirm })
  }
  if (parts.body) {
    steps.push({ kind: 'write', data: parts.body })
  }
  if (parts.submit) {
    if (parts.submitDelayMs > 0) {
      steps.push({ kind: 'pause', ms: parts.submitDelayMs })
    }
    steps.push({ kind: 'write', data: parts.submit })
    if (parts.submitRetry) {
      if (parts.submitRetry.delayMs > 0) {
        steps.push({ kind: 'pause', ms: parts.submitRetry.delayMs })
      }
      steps.push({ kind: 'write', data: parts.submitRetry.data })
    }
  }
  return { steps }
}

export type SessionInputProgramRejection =
  | 'session_input_program_empty'
  | 'session_input_program_too_many_steps'
  | 'session_input_program_pause_too_long'
  | 'session_input_program_too_large'

/** Null when the program is acceptable; otherwise why the host refuses it. */
export function rejectSessionInputProgram(
  program: SessionInputProgram
): SessionInputProgramRejection | null {
  const steps = program.steps
  if (!Array.isArray(steps) || steps.length === 0) {
    return 'session_input_program_empty'
  }
  if (steps.length > SESSION_INPUT_MAX_STEPS) {
    return 'session_input_program_too_many_steps'
  }
  let totalPauseMs = 0
  let totalBytes = 0
  for (const step of steps) {
    if (step.kind === 'write') {
      totalBytes += getTerminalInputByteLength(step.data)
      continue
    }
    const ms = step.kind === 'pause' ? step.ms : step.afterMs
    if (!Number.isFinite(ms) || ms < 0 || ms > SESSION_INPUT_MAX_PAUSE_MS) {
      return 'session_input_program_pause_too_long'
    }
    totalPauseMs += ms
    if (step.kind === 'clear-confirm') {
      totalBytes += getTerminalInputByteLength(step.widenTo)
    }
  }
  if (totalPauseMs > SESSION_INPUT_MAX_TOTAL_PAUSE_MS) {
    return 'session_input_program_pause_too_long'
  }
  if (totalBytes > TERMINAL_INPUT_MAX_BYTES) {
    return 'session_input_program_too_large'
  }
  return null
}
