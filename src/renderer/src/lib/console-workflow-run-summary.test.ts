import { describe, expect, it, vi } from 'vitest'
import { workflowJobFixture } from '@/components/console-workflows/console-workflow-test-fixtures'
import type { ConsoleJobRecord } from '../../../shared/console-workflow-task-types'
import { describeWorkflowRun, workflowsOfJobs } from './console-workflow-run-summary'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, value: string) => value }))

function stage(
  id: string,
  key: string,
  state: string,
  after: string[] = [],
  extra: Partial<ReturnType<typeof workflowJobFixture>> = {}
) {
  const job = workflowJobFixture({ id, title: key, workflow_state: state, ...extra })
  job.policy.workflow.key = key
  job.policy.workflow.after = after
  return job
}

describe('describeWorkflowRun', () => {
  it('is nothing for a workflow with no stages', () => {
    expect(describeWorkflowRun([])).toBeNull()
  })

  it('names the first stage in after-order that has not passed, with what it waits on', () => {
    const summary = describeWorkflowRun([
      stage('job_3', 'verify', 'queued', ['job_2']),
      stage('job_1', 'build', 'done'),
      stage('job_2', 'review', 'blocked', ['job_1'], {
        blockers: ['require_merged'],
        machine: 'mw0003',
        pr_url: 'https://github.com/acme/repo/pull/9'
      })
    ])
    expect(summary).toEqual({
      total: 3,
      finished: 1,
      current: {
        index: 2,
        key: 'review',
        title: 'review',
        state: 'blocked',
        blockers: ['require_merged'],
        machine: 'mw0003',
        prUrl: 'https://github.com/acme/repo/pull/9'
      }
    })
  })

  it('treats a skipped mark and the finished words as passed stages', () => {
    const skipped = stage('job_2', 'review', 'pending', ['job_1'])
    skipped.policy.workflow.skipped = 'no reviewer needed'
    const summary = describeWorkflowRun([
      stage('job_1', 'build', 'Completed'),
      skipped,
      stage('job_3', 'verify', 'running', ['job_2'])
    ])
    expect(summary).toMatchObject({ total: 3, finished: 2, current: { index: 3, key: 'verify' } })
  })

  it('has no current stage once every stage has passed', () => {
    expect(
      describeWorkflowRun([
        stage('job_1', 'build', 'done'),
        stage('job_2', 'ship', 'done', ['job_1'])
      ])
    ).toEqual({ total: 2, finished: 2, current: null })
  })

  it('keeps the server order when the graph cannot be laid out', () => {
    const summary = describeWorkflowRun([
      stage('job_1', 'a', 'queued', ['job_2']),
      stage('job_2', 'b', 'queued', ['job_1'])
    ])
    expect(summary?.current?.key).toBe('a')
  })
})

describe('workflowsOfJobs', () => {
  function record(id: string, workflowId: string | undefined, updatedAt: string | null) {
    return {
      id,
      task_id: 'btk_test1234',
      title: id,
      status: 'queued',
      updated_at: updatedAt,
      policy: workflowId
        ? { workflow: { ...workflowJobFixture().policy.workflow, workflow_id: workflowId } }
        : {}
    } as ConsoleJobRecord
  }

  it('lists each workflow once, freshest first, ignoring jobs with no workflow', () => {
    expect(
      workflowsOfJobs([
        record('job_a1', 'wf_a', '2026-09-01T00:00:00Z'),
        record('job_b1', 'wf_b', '2026-09-03T00:00:00Z'),
        record('job_a2', 'wf_a', '2026-09-02T00:00:00Z'),
        record('job_none', undefined, '2026-09-09T00:00:00Z')
      ])
    ).toEqual([
      { id: 'wf_b', updatedAt: '2026-09-03T00:00:00Z' },
      { id: 'wf_a', updatedAt: '2026-09-02T00:00:00Z' }
    ])
  })

  it('falls back to the dispatch id when a job carries no workflow id', () => {
    const job = record('job_d', 'wf_x', null)
    delete job.policy.workflow!.workflow_id
    expect(workflowsOfJobs([job])).toEqual([{ id: 'wf_test', updatedAt: null }])
  })
})
