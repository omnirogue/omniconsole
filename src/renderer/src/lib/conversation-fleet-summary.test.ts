import { describe, expect, it } from 'vitest'
import type { ConsoleWorkflowJob } from '../../../shared/console-workflow-types'
import { conversationFleetSummary } from './conversation-fleet-summary'

function job(status: string, extra: Partial<ConsoleWorkflowJob> = {}): ConsoleWorkflowJob {
  return {
    id: 'job_summary',
    status,
    machine: 'mw0002',
    can_decide: false,
    pr_url: null,
    updated_at: null,
    ...extra
  } as ConsoleWorkflowJob
}

const receipt = {
  admission: 'accepted' as const,
  verified: true,
  createdAt: '2026-10-03T14:00:00.000Z'
}

describe('conversation fleet summary', () => {
  it('keeps an old failure honest and dates the work rather than its recovery', () => {
    const summary = conversationFleetSummary({
      ...receipt,
      jobs: [
        job('done', { updated_at: '2026-09-01T12:00:00.000Z' }),
        job('failed', { updated_at: '2026-09-01T12:02:00.000Z' })
      ]
    })
    expect(summary).toEqual({
      text: 'Some work couldn’t finish. Steps finished: 1 of 2.',
      completed: 1,
      total: 2,
      lastActivityAt: '2026-09-01T12:02:00.000Z',
      lastActivitySource: 'job'
    })
  })

  it.each(['done', 'failed', 'running', 'unknown_status'])(
    'treats cached %s as last known progress after losing contact',
    (status) => {
      const summary = conversationFleetSummary({
        ...receipt,
        verified: false,
        jobs: [job(status)]
      })
      expect(summary.text).toBe(
        `Current status is unavailable. Steps finished at last check: ${status === 'done' ? 1 : 0} of 1.`
      )
    }
  )

  it('does not infer execution exit from a cancellation request', () => {
    for (const status of ['cancelled', 'cancel_requested']) {
      expect(conversationFleetSummary({ ...receipt, jobs: [job(status)] }).text).toBe(
        'Cancellation requested. Stopping has not been confirmed.'
      )
    }
  })

  it('does not call all work stopped when a failed step has a queued sibling', () => {
    expect(
      conversationFleetSummary({ ...receipt, jobs: [job('failed'), job('queued')] }).text
    ).toBe('Some work couldn’t finish. Steps finished: 0 of 2.')
  })

  it('does not describe skipped steps as completed', () => {
    expect(conversationFleetSummary({ ...receipt, jobs: [job('done'), job('skipped')] }).text).toBe(
      'Finished.'
    )
  })

  it('keeps pending admission uncertain even with cached completion', () => {
    expect(
      conversationFleetSummary({ ...receipt, admission: 'pending', jobs: [job('done')] }).text
    ).toBe('Checking whether this work started.')
  })

  it('shows continued activity when a failed step has a running sibling', () => {
    expect(
      conversationFleetSummary({ ...receipt, jobs: [job('failed'), job('running')] }).text
    ).toBe('Work is continuing. Steps finished: 0 of 2.')
  })

  it('distinguishes a decision, a review link, and a wait with no action', () => {
    expect(
      conversationFleetSummary({
        ...receipt,
        jobs: [job('blocked', { can_decide: true })]
      }).text
    ).toBe('A decision is needed to continue.')
    expect(
      conversationFleetSummary({
        ...receipt,
        jobs: [job('pr_open', { pr_url: 'https://example.test/review' })]
      }).text
    ).toBe('Your review is ready.')
    expect(conversationFleetSummary({ ...receipt, jobs: [job('pr_open')] }).text).toBe(
      'Waiting to continue. Steps finished: 0 of 1.'
    )
  })

  it('ignores invalid timestamps and identifies the receipt fallback as recorded time', () => {
    expect(
      conversationFleetSummary({ ...receipt, jobs: [job('failed', { updated_at: 'invalid' })] })
    ).toMatchObject({ lastActivityAt: receipt.createdAt, lastActivitySource: 'receipt' })
    expect(conversationFleetSummary({ ...receipt, createdAt: 'invalid', jobs: [] })).toMatchObject({
      lastActivityAt: null,
      lastActivitySource: null
    })
  })

  it('keeps every English summary below 35 words without raw status codes', () => {
    const scenarios = [
      [],
      [job('queued')],
      [job('running')],
      [job('failed')],
      [job('done')],
      [job('cancel_requested')],
      [job('unrecognized_backend_state')],
      [job('blocked', { can_decide: true })],
      [job('pr_open', { pr_url: 'https://example.test/review' })]
    ]
    for (const jobs of scenarios) {
      for (const admission of ['pending', 'accepted'] as const) {
        for (const verified of [false, true]) {
          const { text } = conversationFleetSummary({ ...receipt, admission, verified, jobs })
          expect(text.split(/\s+/).length).toBeLessThan(35)
          expect(text).not.toMatch(/cancel_requested|unrecognized_backend_state|pr_open/)
        }
      }
    }
  })
})
