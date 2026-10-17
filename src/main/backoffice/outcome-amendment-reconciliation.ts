import type {
  OutcomeAmendmentCancellationPort,
  OutcomeAmendmentIntent,
  OutcomeAmendmentJob,
  OutcomeAmendmentObservedJob
} from '../../shared/outcome-amendment-cancellation'

const blocked = (job: OutcomeAmendmentJob, error: string): OutcomeAmendmentJob => ({
  ...job,
  state: 'unverifiable',
  error
})

function identityMatches(job: OutcomeAmendmentJob, observed: OutcomeAmendmentObservedJob): boolean {
  return (
    observed.jobId === job.jobId &&
    observed.workflowId === job.workflowId &&
    observed.approvedDigest === job.approvedDigest &&
    observed.taskId === job.taskId &&
    (job.expectedAttempt === null || observed.attempt === job.expectedAttempt) &&
    (job.expectedLeaseGeneration === null ||
      observed.leaseGeneration === job.expectedLeaseGeneration) &&
    (!job.dispatchId || observed.dispatchId === job.dispatchId) &&
    (!job.runId || observed.runId === job.runId)
  )
}

function terminalReceipt(
  job: OutcomeAmendmentJob,
  observed: OutcomeAmendmentObservedJob,
  now: number
): OutcomeAmendmentJob | null {
  if (
    observed.state === 'failed' &&
    observed.terminalStopped &&
    observed.acceptedFailure?.resultReceiptId &&
    observed.acceptedFailure.resultFingerprint
  ) {
    return {
      ...job,
      state: 'cancelled',
      receipt: {
        outcome: 'failed',
        serverAcknowledged: true,
        terminal: 'failed',
        observedState: 'failed',
        observedAt: now,
        ...observed.acceptedFailure
      },
      error: undefined
    }
  }
  if (observed.state === 'completed' && observed.terminalStopped && observed.acceptedCompletion) {
    return {
      ...job,
      state: 'cancelled',
      receipt: {
        outcome: 'completed',
        serverAcknowledged: true,
        terminal: 'completed',
        observedState: 'completed',
        observedAt: now,
        ...observed.acceptedCompletion
      },
      error: undefined
    }
  }
  if (
    observed.state === 'cancelled' &&
    observed.serverCancellationAcknowledged &&
    observed.terminalStopped
  ) {
    return {
      ...job,
      state: 'cancelled',
      receipt: {
        outcome: 'cancelled',
        serverAcknowledged: true,
        terminal: observed.dispatchId || observed.runId ? 'stopped' : 'not_started',
        observedState: 'cancelled',
        observedAt: now
      },
      error: undefined
    }
  }
  return null
}

export async function reconcileOutcomeAmendment(
  port: OutcomeAmendmentCancellationPort,
  intent: OutcomeAmendmentIntent,
  persist: (next: OutcomeAmendmentIntent) => Promise<void>
): Promise<OutcomeAmendmentIntent> {
  let next: OutcomeAmendmentIntent = { ...intent, state: 'reconciling', jobs: [...intent.jobs] }
  await persist(next)

  for (let index = 0; index < next.jobs.length; index += 1) {
    const job = next.jobs[index]!
    if (job.state === 'cancelled' && job.receipt) {
      continue
    }
    const observed = await port.readJob(job.jobId)
    if (!identityMatches(job, observed)) {
      next.jobs[index] = blocked(
        job,
        'Cancellation target identity changed or could not be verified.'
      )
      continue
    }
    const receipt = terminalReceipt(job, observed, port.now())
    if (receipt) {
      next.jobs[index] = receipt
      await persist(next)
      continue
    }
    if (observed.state !== 'queued' && observed.state !== 'running') {
      next.jobs[index] = blocked(job, 'Cancellation state is unknown or lacks terminal proof.')
      continue
    }

    next.jobs[index] = { ...job, state: 'requested', error: undefined }
    await persist(next)
    await (observed.state === 'queued'
      ? port.cancelQueued(job.jobId)
      : port.cancelRunning(observed))

    const settled = await port.readJob(job.jobId)
    next.jobs[index] = identityMatches(job, settled)
      ? (terminalReceipt(job, settled, port.now()) ??
        blocked(job, 'Cancellation did not produce server and terminal receipts.'))
      : blocked(job, 'Cancellation target identity changed while stopping.')
    await persist(next)
  }

  next = {
    ...next,
    state: next.jobs.every((job) => job.state === 'cancelled') ? 'ready' : 'blocked'
  }
  await persist(next)
  return next
}
