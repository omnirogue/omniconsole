import { z } from 'zod'
import { sessionOutcomeRecovery } from './session-outcome-recovery-reason'

/**
 * What the host does about a stopped attempt before anyone is asked anything: the bounded recovery
 * ladder (`docs/reference/session-run-lifecycle.md`). Pure, clock-injected, and the only place the
 * bounds live. A person's Resume is the same ladder with the bound and the deadline lifted.
 */
export const SESSION_ATTEMPT_FAILURE_CODES = [
  'launch-not-started',
  'worker-stalled',
  'worker-exited',
  'agent-turn-failed',
  'startup-blocked',
  'prompt-not-accepted',
  'provider-usage-limit',
  'provider-authentication',
  'operator-closed',
  'brief-too-large',
  'unknown'
] as const
export type SessionAttemptFailureCode = (typeof SESSION_ATTEMPT_FAILURE_CODES)[number]

export const sessionAttemptFailureSchema = z
  .object({
    code: z.enum(SESSION_ATTEMPT_FAILURE_CODES),
    /** A machine id that refines the code (a startup blocker id, a dispatch stage); never prose. */
    detail: z
      .string()
      .regex(/^[A-Za-z0-9_.:-]{1,120}$/)
      .optional(),
    at: z.number().finite().nonnegative()
  })
  .strict()
export type SessionAttemptFailure = z.infer<typeof sessionAttemptFailureSchema>

/** The agent itself is asking its person something; the attempt is alive, not failed. */
export const sessionAttemptAwaitingSchema = z
  .object({
    kind: z.enum(['permission', 'clarification']),
    prompt: z.string().trim().min(1).max(2_000),
    since: z.number().finite().nonnegative(),
    paneKey: z.string().trim().min(1).max(200).optional()
  })
  .strict()
export type SessionAttemptAwaiting = z.infer<typeof sessionAttemptAwaitingSchema>

export const SESSION_RECOVERY_MAX_AUTO_RETRIES = 2
export const SESSION_RECOVERY_BACKOFF_MS = [15_000, 60_000] as const
/** A provider's usage wall does not lift in seconds. */
export const SESSION_RECOVERY_USAGE_BACKOFF_MS = [5 * 60_000, 20 * 60_000] as const
/** Work that failed longer ago than this is never relaunched without the person saying so. */
export const SESSION_RECOVERY_DEADLINE_MS = 6 * 60 * 60_000
/** How long an unverifiable worker may still turn out to be alive before the run says it failed. */
export const SESSION_RECOVERY_UNVERIFIABLE_GRACE_MS = 10 * 60_000

/** Startup prompts only a person may answer once the host's own remediation did not clear them. */
const APPROVAL_STARTUP_BLOCKERS: ReadonlySet<string> = new Set([
  'codex-hooks-review-prompt',
  'codex-trust-workspace',
  'codex-interactive-prompt',
  'agent-approval-prompt'
])

/** A supported input prompt the live worker can continue after its person answers. */
export function isSessionAttemptApprovalStartupBlocker(blocker: string | undefined): boolean {
  return blocker !== undefined && APPROVAL_STARTUP_BLOCKERS.has(blocker)
}

export type SessionAttemptRequirement =
  | 'provider-authentication'
  | 'provider-usage-limit'
  | 'provider-approval'
  | 'brief-too-large'

export type SessionAttemptRecoveryDecision =
  | { kind: 'none' }
  /** Provably safe to start one replacement now. */
  | { kind: 'retry'; rung: number }
  /** A replacement is due later; the run is recovering until then. */
  | { kind: 'wait'; rung: number; until: number }
  /** Cannot prove the worker stopped: keep observing, never start a second one. */
  | { kind: 'hold'; until: number }
  | { kind: 'attention'; requirement: SessionAttemptRequirement; code: SessionAttemptFailureCode }
  | {
      kind: 'fail'
      code: SessionAttemptFailureCode | 'unverifiable-worker'
      because: 'exhausted' | 'deadline' | 'unsafe' | 'cancelled'
    }

export type SessionAttemptRecoveryInput = {
  attempt: {
    state: string
    launchDisposition?: string
    dispatchId?: string
    failure?: SessionAttemptFailure
    updatedAt: number
  }
  /** Replacements already spent on this action at this outcome revision and plan version. */
  retriesUsed: number
  /** The host proved the worker's receipt is settled (or that the launch never started). */
  workerSettled: boolean
  now: number
  /** The person pressed Resume: lifts the bound and the deadline, never the safety proof. */
  userInitiated?: boolean
}

export function sessionAttemptFailureCode(
  attempt: SessionAttemptRecoveryInput['attempt']
): SessionAttemptFailureCode {
  if (attempt.failure) {
    return attempt.failure.code
  }
  return attempt.launchDisposition === 'not-started' ? 'launch-not-started' : 'unknown'
}

function exhausted(
  code: SessionAttemptFailureCode,
  detail: string | undefined
): SessionAttemptRecoveryDecision {
  if (code === 'provider-usage-limit') {
    return { kind: 'attention', requirement: 'provider-usage-limit', code }
  }
  if (code === 'startup-blocked' && isSessionAttemptApprovalStartupBlocker(detail)) {
    return { kind: 'attention', requirement: 'provider-approval', code }
  }
  return { kind: 'fail', code, because: 'exhausted' }
}

export function decideSessionAttemptRecovery(
  input: SessionAttemptRecoveryInput
): SessionAttemptRecoveryDecision {
  const { attempt, now } = input
  const recovery = sessionOutcomeRecovery(attempt)
  if (!recovery) {
    return { kind: 'none' }
  }
  const code = sessionAttemptFailureCode(attempt)
  const failedAt = attempt.failure?.at ?? attempt.updatedAt
  // Requirements no retry can meet are asked for at once; retrying first would only delay the ask.
  // A person's Resume IS their answer ("I signed in", "I shortened it"), so it is tried — through
  // the same safety proof as any relaunch — and a requirement still unmet is simply asked again.
  if (!input.userInitiated && code === 'provider-authentication') {
    return { kind: 'attention', requirement: 'provider-authentication', code }
  }
  if (!input.userInitiated && code === 'brief-too-large') {
    return { kind: 'attention', requirement: 'brief-too-large', code }
  }
  if (code === 'operator-closed' && !input.userInitiated) {
    // The person ended this worker themselves; starting it again would undo their decision. Said
    // before the safety proof, because declining to relaunch needs none.
    return { kind: 'fail', code, because: 'cancelled' }
  }
  // The settled receipt is the proof, whatever an older record forgot to say about its launch.
  const safe =
    recovery.reason === 'launch-not-started' || (input.workerSettled && Boolean(attempt.dispatchId))
  if (!safe) {
    // Lost contact is not proof of death: a second worker cannot be recalled.
    const until = failedAt + SESSION_RECOVERY_UNVERIFIABLE_GRACE_MS
    return now < until && !input.userInitiated
      ? { kind: 'hold', until }
      : { kind: 'fail', code: 'unverifiable-worker', because: 'unsafe' }
  }
  if (input.userInitiated) {
    return { kind: 'retry', rung: input.retriesUsed }
  }
  if (now - failedAt > SESSION_RECOVERY_DEADLINE_MS) {
    return { kind: 'fail', code, because: 'deadline' }
  }
  if (input.retriesUsed >= SESSION_RECOVERY_MAX_AUTO_RETRIES) {
    return exhausted(code, attempt.failure?.detail)
  }
  const ladder =
    code === 'provider-usage-limit'
      ? SESSION_RECOVERY_USAGE_BACKOFF_MS
      : SESSION_RECOVERY_BACKOFF_MS
  const until = failedAt + ladder[Math.min(input.retriesUsed, ladder.length - 1)]!
  return now < until
    ? { kind: 'wait', rung: input.retriesUsed, until }
    : { kind: 'retry', rung: input.retriesUsed }
}
