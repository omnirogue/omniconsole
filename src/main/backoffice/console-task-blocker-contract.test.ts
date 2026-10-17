import { describe, expect, it } from 'vitest'
import { taskDetail } from './console-workflow-records'

describe('canonical task blocker reads', () => {
  it.each([
    ['Waiting for checks', 'Waiting for checks'],
    [{ detail: 'Waiting for checks', reason: 'external', source: 'emp_sal' }, 'Waiting for checks'],
    [{ reason: 'Waiting for approval', at: '2026-09-17T16:00:00Z' }, 'Waiting for approval'],
    [{ detail: '', reason: '' }, null]
  ])('reads the hub string-or-envelope reason %j', (blocked_reason, expected) => {
    const task = { id: 'btk_audit0001', title: 'Proposal', status: 'blocked', blocked_reason }
    expect(taskDetail.parse({ task }).blocked_reason).toBe(expected)
    expect(taskDetail.parse(task).blocked_reason).toBe(expected)
  })

  it.each([42, { reason: 42 }])('refuses an invalid reason %j', (blocked_reason) => {
    const task = { id: 'btk_audit0001', title: 'Proposal', status: 'blocked', blocked_reason }
    expect(taskDetail.safeParse(task).success).toBe(false)
  })
})
