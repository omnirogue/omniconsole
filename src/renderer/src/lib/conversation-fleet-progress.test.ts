import { describe, expect, it } from 'vitest'
import {
  cancellableFleetJobs,
  conversationFleetProgress,
  conversationFleetSettled,
  fleetRunPersonActions,
  retryableFleetJobs
} from './conversation-fleet-progress'
import type { ConsoleWorkflowJob } from '../../../shared/console-workflow-types'

function job(status: string, extra: Partial<ConsoleWorkflowJob> = {}): ConsoleWorkflowJob {
  return {
    id: 'job_12345678',
    status,
    machine: 'mw0002',
    can_decide: false,
    pr_url: null,
    ...extra
  } as ConsoleWorkflowJob
}

describe('conversation fleet attention', () => {
  it('distinguishes executing stages from queued work', () => {
    expect(conversationFleetProgress([job('queued'), job('running')], true)).toMatchObject({
      phase: 'working',
      total: 2,
      completed: 0
    })
  })
  it('is Needs you only when the person can decide or open a review from the details', () => {
    const pr = 'https://example.test/pr/1'
    expect(conversationFleetProgress([job('queued')], true).phase).toBe('waiting')
    expect(conversationFleetProgress([job('blocked', { can_decide: true })], true).phase).toBe(
      'needs-you'
    )
    expect(conversationFleetProgress([job('pr_open', { pr_url: pr })], true).phase).toBe(
      'needs-you'
    )
    expect(conversationFleetProgress([job('pr_open', { pr_url: pr })], true).reviewUrls).toEqual([
      pr
    ])
    // Sal, 2026-09-26: a "needs a human" status with nothing to click is someone else's wait.
    expect(conversationFleetProgress([job('pr_open')], true).phase).toBe('waiting')
    expect(
      conversationFleetProgress([job('pr_open', { pr_url: 'not-a-review-link' })], true).phase
    ).toBe('waiting')
    expect(
      conversationFleetProgress([job('pr_open', { pr_url: 'javascript:alert(1)' })], true).phase
    ).toBe('waiting')
    expect(conversationFleetProgress([job('awaiting_review')], true).phase).toBe('waiting')
    expect(
      conversationFleetProgress([job('blocked', { workflow_state: 'needs_human' })], true).phase
    ).toBe('waiting')
    expect(
      conversationFleetProgress([job('running', { workflow_state: 'needs_human' })], true).phase
    ).toBe('working')
    // A PR opened by a stage that is still running is not ready for review yet.
    expect(conversationFleetProgress([job('running', { pr_url: pr })], true).phase).toBe('working')
    expect(fleetRunPersonActions([job('running', { pr_url: pr })]).reviewUrls).toEqual([])
    expect(fleetRunPersonActions([job('blocked', { can_decide: true })]).decisions).toHaveLength(1)
  })
  it('reads a failed or rejected stage as failed, never as something the person must do', () => {
    expect(conversationFleetProgress([job('failed')], true).phase).toBe('failed')
    expect(conversationFleetProgress([job('rejected')], true).phase).toBe('failed')
    expect(conversationFleetProgress([job('failed'), job('done')], true).phase).toBe('failed')
    expect(conversationFleetProgress([job('failed'), job('running')], true).phase).toBe('working')
    // A PR left behind by a stage that failed is not a review waiting on the person.
    expect(
      conversationFleetProgress([job('failed', { pr_url: 'https://example.test/pr/1' })], true)
        .phase
    ).toBe('failed')
    // A failed run stays retryable work: it is not settled, and it is not complete.
    expect(conversationFleetSettled('failed')).toBe(false)
  })
  it('lets a real human requirement outrank a failed sibling stage', () => {
    expect(
      conversationFleetProgress(
        [job('failed'), job('pr_open', { pr_url: 'https://example.test/pr/1' })],
        true
      ).phase
    ).toBe('needs-you')
    expect(conversationFleetProgress([job('failed'), job('pr_open')], true).phase).toBe('failed')
    expect(conversationFleetProgress([job('failed', { can_decide: true })], true).phase).toBe(
      'needs-you'
    )
  })
  it('does not settle cancellation without execution-host exit evidence', () => {
    expect(conversationFleetProgress([job('cancelled'), job('done')], true).phase).toBe(
      'unverifiable'
    )
    expect(conversationFleetProgress([job('cancelled'), job('running')], true).phase).toBe(
      'unverifiable'
    )
    expect(conversationFleetProgress([job('cancelled'), job('failed')], true).phase).toBe(
      'unverifiable'
    )
    expect(conversationFleetProgress([job('cancelled', { can_decide: true })], true).phase).toBe(
      'unverifiable'
    )
    expect(conversationFleetProgress([job('cancelled')], false).phase).toBe('unverifiable')
    expect(conversationFleetSettled('cancelled')).toBe(false)
    expect(conversationFleetSettled('complete')).toBe(true)
    expect(conversationFleetSettled('unverifiable')).toBe(false)
  })
  it('cancels live stages and retries stopped ones after the stopped stages they wait on', () => {
    const stage = (id: string, status: string, after: string[]) =>
      job(status, {
        id,
        policy: { workflow: { after } } as unknown as ConsoleWorkflowJob['policy']
      })
    const jobs = [
      stage('job_third', 'cancelled', ['job_second']),
      stage('job_second', 'failed', ['job_first']),
      stage('job_first', 'cancelled', []),
      stage('job_live', 'running', []),
      stage('job_done', 'done', [])
    ]
    expect(cancellableFleetJobs(jobs).map((entry) => entry.id)).toEqual(['job_live'])
    expect(retryableFleetJobs(jobs).map((entry) => entry.id)).toEqual([
      'job_first',
      'job_second',
      'job_third'
    ])
    // A job restored without its workflow policy has no known predecessor.
    expect(retryableFleetJobs([job('failed')]).map((entry) => entry.id)).toEqual(['job_12345678'])
  })
  it('requires every job to finish and never treats an observation failure as completion', () => {
    expect(conversationFleetProgress([job('done'), job('running')], true).phase).toBe('working')
    expect(conversationFleetProgress([job('done'), job('merged')], true).phase).toBe('complete')
    expect(conversationFleetProgress([job('done')], false).phase).toBe('unverifiable')
    expect(conversationFleetProgress([], true).phase).toBe('unverifiable')
    expect(conversationFleetProgress([job('new_unknown_status')], true).phase).toBe('unverifiable')
  })
})
