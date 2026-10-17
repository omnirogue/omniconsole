import { describe, expect, it } from 'vitest'
import { localWorkflowRunStatus } from './local-workflow-run-status'

// The run's row and its attempts; this run launched none yet.
const db = {
  prepare: () => ({
    get: () => ({ conversation_id: JSON.stringify(['wt-1', 'tab-1']) }),
    all: () => []
  })
} as never
const view = {
  executionId: 'run-1',
  preset: 'graph',
  state: 'running',
  prompt: 'Find defects',
  startedAt: 1,
  calls: []
}
const FOUND = {
  key: 'find.r1.1',
  title: 'lost write',
  detail: 'How lost write breaks.',
  location: 'src/store.ts:12',
  severity: 'high' as const,
  stepId: 'verify',
  round: 1
}

describe('omni workflow status: findings verified so far', () => {
  it('reports the frozen requester id and omits it on older runs', () => {
    expect(
      localWorkflowRunStatus(db, {
        ...view,
        requestedBy: 'Uma',
        requestedById: 'emp_uma'
      } as never)
    ).toMatchObject({ requestedBy: 'Uma', requestedById: 'emp_uma' })
    expect(localWorkflowRunStatus(db, view as never)).not.toHaveProperty('requestedById')
  })

  it('counts and lists them from the projected graph run', () => {
    const status = localWorkflowRunStatus(db, {
      ...view,
      graphRun: { verified: [FOUND] }
    } as never)
    expect(status.verified).toEqual({ count: 1, items: [FOUND] })
    expect(
      localWorkflowRunStatus(db, { ...view, graphRun: { verified: [] } } as never).verified
    ).toEqual({ count: 0, items: [] })
  })

  it('leaves them out of a run that reviews nothing one by one', () => {
    expect(localWorkflowRunStatus(db, view as never)).not.toHaveProperty('verified')
    expect(localWorkflowRunStatus(db, { ...view, graphRun: {} } as never)).not.toHaveProperty(
      'verified'
    )
  })
})
