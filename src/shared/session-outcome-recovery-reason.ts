/**
 * What may be done with an attempt that stopped, and the words for it. The distinction is the SSH
 * execution boundary's: a settled receipt proves the worker exited, and only then may a retry
 * start a second one; lost contact proves nothing and is reconciled by hand.
 */
export type SessionOutcomeRecoveryReason = 'launch-not-started' | 'worker-dead' | 'unverifiable'

export type SessionOutcomeRecovery = {
  reason: SessionOutcomeRecoveryReason
  action: 'retry' | 'reconcile'
  label: string
}

export const SESSION_OUTCOME_RECOVERY: Record<
  SessionOutcomeRecoveryReason,
  SessionOutcomeRecovery
> = {
  'launch-not-started': {
    reason: 'launch-not-started',
    action: 'retry',
    label: 'Retry — the launch never started'
  },
  'worker-dead': { reason: 'worker-dead', action: 'retry', label: 'Retry — worker confirmed dead' },
  unverifiable: {
    reason: 'unverifiable',
    action: 'reconcile',
    label: 'Reconcile — cannot prove it stopped'
  }
}

/** Refused because the assembled brief is past the worker limit; shortening it is the only fix. */
export const SESSION_OUTCOME_BRIEF_TOO_LARGE = 'brief-too-large'

/**
 * How a stopped attempt may be recovered, read from what it persisted. An attempt blocked without
 * a launch disposition predates that record: it cannot prove the worker stopped, so it reconciles.
 */
export function sessionOutcomeRecovery(
  attempt: Pick<
    { state: string; launchDisposition?: string; dispatchId?: string },
    'state' | 'launchDisposition' | 'dispatchId'
  >
): SessionOutcomeRecovery | null {
  if (attempt.state !== 'blocked' && attempt.state !== 'unverifiable') {
    return null
  }
  if (attempt.state === 'unverifiable' || attempt.launchDisposition === 'unverifiable') {
    return SESSION_OUTCOME_RECOVERY.unverifiable
  }
  if (attempt.launchDisposition === 'not-started') {
    return SESSION_OUTCOME_RECOVERY['launch-not-started']
  }
  return attempt.launchDisposition === 'started' && attempt.dispatchId
    ? SESSION_OUTCOME_RECOVERY['worker-dead']
    : SESSION_OUTCOME_RECOVERY.unverifiable
}
