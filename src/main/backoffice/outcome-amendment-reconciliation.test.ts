import { describe, expect, it, vi } from 'vitest'
import type {
  OutcomeAmendmentCancellationPort,
  OutcomeAmendmentIntent,
  OutcomeAmendmentObservedJob
} from '../../shared/outcome-amendment-cancellation'
import { reconcileOutcomeAmendment } from './outcome-amendment-reconciliation'

const job = {
  jobId: 'job_1',
  workflowId: 'wf_1',
  approvedDigest: 'digest',
  taskId: 'task_1',
  expectedAttempt: 2,
  expectedLeaseGeneration: 3,
  state: 'pending' as const,
  dispatchId: 'dispatch_1',
  runId: 'run_1'
}
const intent = (): OutcomeAmendmentIntent => ({
  id: 'amend_1',
  principal: 'sal',
  sourceOperationIds: ['op_1'],
  state: 'prepared',
  jobs: [job]
})
const observed = (state: OutcomeAmendmentObservedJob['state']): OutcomeAmendmentObservedJob => ({
  jobId: 'job_1',
  workflowId: 'wf_1',
  approvedDigest: 'digest',
  taskId: 'task_1',
  state,
  attempt: 2,
  leaseGeneration: 3,
  dispatchId: 'dispatch_1',
  runId: 'run_1',
  serverCancellationAcknowledged: state === 'cancelled',
  terminalStopped: state === 'cancelled' || state === 'completed',
  acceptedCompletion:
    state === 'completed'
      ? {
          resultReceiptId: 'receipt_1',
          resultFingerprint: 'fingerprint_1',
          verificationReportId: 'report_1'
        }
      : null
})
function port(
  readJob: OutcomeAmendmentCancellationPort['readJob']
): OutcomeAmendmentCancellationPort {
  return { readJob, cancelQueued: vi.fn(), cancelRunning: vi.fn(), now: () => 10 }
}

describe('reconcileOutcomeAmendment', () => {
  it('persists requested before queued cancellation and requires readback receipts', async () => {
    const events: string[] = []
    const p = port(
      vi.fn().mockResolvedValueOnce(observed('queued')).mockResolvedValueOnce(observed('cancelled'))
    )
    vi.mocked(p.cancelQueued).mockImplementation(async () => {
      events.push('cancel')
    })
    const result = await reconcileOutcomeAmendment(p, intent(), async (next) => {
      events.push(`persist:${next.jobs[0]!.state}`)
    })
    expect(events.indexOf('persist:requested')).toBeLessThan(events.indexOf('cancel'))
    expect(result).toMatchObject({
      state: 'ready',
      jobs: [{ state: 'cancelled', receipt: { terminal: 'stopped' } }]
    })
  })

  it('re-reads requested work and uses bound running cancellation without queued cancellation', async () => {
    const initial = intent()
    initial.jobs[0] = { ...job, state: 'requested' }
    const p = port(
      vi
        .fn()
        .mockResolvedValueOnce(observed('running'))
        .mockResolvedValueOnce(observed('cancelled'))
    )
    const result = await reconcileOutcomeAmendment(p, initial, vi.fn())
    expect(p.cancelRunning).toHaveBeenCalledWith(observed('running'))
    expect(p.cancelQueued).not.toHaveBeenCalled()
    expect(result.state).toBe('ready')
  })

  it('preserves completed work without a cancellation effect', async () => {
    const p = port(vi.fn().mockResolvedValue(observed('completed')))
    const result = await reconcileOutcomeAmendment(p, intent(), vi.fn())
    expect(p.cancelQueued).not.toHaveBeenCalled()
    expect(p.cancelRunning).not.toHaveBeenCalled()
    expect(result.jobs[0]?.receipt?.terminal).toBe('completed')
  })

  it('does not cancel when persisting the requested marker fails', async () => {
    const p = port(vi.fn().mockResolvedValue(observed('queued')))
    const persist = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(reconcileOutcomeAmendment(p, intent(), persist)).rejects.toThrow(
      'disk unavailable'
    )
    expect(p.cancelQueued).not.toHaveBeenCalled()
  })

  it('recovers a lost cancellation response by readback without repeating the effect', async () => {
    const saved: OutcomeAmendmentIntent[] = []
    const first = port(vi.fn().mockResolvedValue(observed('queued')))
    vi.mocked(first.cancelQueued).mockRejectedValue(new Error('response lost after request'))
    await expect(
      reconcileOutcomeAmendment(first, intent(), async (next) => {
        saved.push(structuredClone(next))
      })
    ).rejects.toThrow('response lost')
    const requested = saved.findLast((value) => value.jobs[0]?.state === 'requested')!

    const restarted = port(vi.fn().mockResolvedValue(observed('cancelled')))
    const result = await reconcileOutcomeAmendment(restarted, requested, vi.fn())
    expect(restarted.cancelQueued).not.toHaveBeenCalled()
    expect(restarted.cancelRunning).not.toHaveBeenCalled()
    expect(result.state).toBe('ready')
  })

  it('blocks completed work without accepted server result and terminal proof', async () => {
    const p = port(
      vi.fn().mockResolvedValue({
        ...observed('completed'),
        terminalStopped: false,
        acceptedCompletion: null
      })
    )
    const result = await reconcileOutcomeAmendment(p, intent(), vi.fn())
    expect(result).toMatchObject({ state: 'blocked', jobs: [{ state: 'unverifiable' }] })
  })

  it('fails closed on unknown state or changed execution identity', async () => {
    const p = port(vi.fn().mockResolvedValue({ ...observed('unknown'), attempt: 4 }))
    const result = await reconcileOutcomeAmendment(p, intent(), vi.fn())
    expect(result.state).toBe('blocked')
    expect(result.jobs[0]).toMatchObject({ state: 'unverifiable' })
    expect(p.cancelQueued).not.toHaveBeenCalled()
    expect(p.cancelRunning).not.toHaveBeenCalled()
  })
})

it('preserves an acknowledged physically stopped failure without calling cancellation or inventing acceptance', async () => {
  const p = port(
    vi.fn().mockResolvedValue({
      ...observed('failed'),
      terminalStopped: true,
      acceptedFailure: {
        resultReceiptId: 'failed_result',
        resultFingerprint: 'failed_fingerprint'
      }
    })
  )
  const result = await reconcileOutcomeAmendment(p, intent(), vi.fn())
  expect(result.state).toBe('ready')
  expect(result.jobs[0]!.receipt).toMatchObject({
    outcome: 'failed',
    terminal: 'failed',
    resultReceiptId: 'failed_result'
  })
  expect(result.jobs[0]!.receipt).not.toHaveProperty('verificationReportId')
  expect(p.cancelQueued).not.toHaveBeenCalled()
  expect(p.cancelRunning).not.toHaveBeenCalled()
})
it.each([false, true])(
  'does not settle failure without both physical and server proof (%s)',
  async (terminalStopped) => {
    const p = port(
      vi.fn().mockResolvedValue({
        ...observed('failed'),
        terminalStopped,
        acceptedFailure: terminalStopped
          ? null
          : { resultReceiptId: 'failed_result', resultFingerprint: 'failed_fingerprint' }
      })
    )
    expect((await reconcileOutcomeAmendment(p, intent(), vi.fn())).state).toBe('blocked')
  }
)
