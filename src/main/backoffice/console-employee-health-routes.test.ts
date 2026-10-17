import { describe, expect, it } from 'vitest'
import { EMPLOYEE_TRANSCRIPT_CONTENT_MAX_BYTES } from '../../shared/employee-transcript-contract'
import {
  consoleWorkflowRequestBudget,
  EMPLOYEE_TRANSCRIPT_REQUEST_MAX_BYTES
} from './console-workflow-request-budget'
import { routes } from './console-workflow-routes'

const allows = (method: 'GET' | 'POST' | 'PATCH', path: string): boolean =>
  routes[method].some((route) => route.test.test(path))

describe('employee transcript, app-health and team-memory routes', () => {
  it('permits exactly the three paths the IDE uses, with their verbs', () => {
    expect(allows('POST', '/api/employee-transcripts')).toBe(true)
    expect(allows('POST', '/api/app-health')).toBe(true)
    expect(allows('GET', '/api/team-memory/status')).toBe(true)
  })

  it('refuses the viewer-only admin surfaces and every other shape', () => {
    for (const path of [
      '/api/employee-transcripts/1',
      '/api/employee-transcripts?employee_id=emp_sal',
      '/api/employee-transcripts/purge',
      '/api/admin/transcripts',
      '/api/admin/transcripts/1/content',
      '/api/admin/employee-memory',
      '/api/admin/employee-memory/emp_sal',
      '/api/admin/app-health',
      '/api/team-memory/status?employee_id=emp_sal',
      '/api/app-health/1'
    ]) {
      expect(allows('GET', path), path).toBe(false)
      expect(allows('POST', path), path).toBe(false)
      expect(allows('PATCH', path), path).toBe(false)
    }
    expect(allows('GET', '/api/employee-transcripts')).toBe(false)
    expect(allows('GET', '/api/app-health')).toBe(false)
    expect(allows('POST', '/api/team-memory/status')).toBe(false)
  })

  it('gives only the transcript upload a body budget above the default, sized to its content cap', () => {
    expect(consoleWorkflowRequestBudget('/api/employee-transcripts')).toBe(
      EMPLOYEE_TRANSCRIPT_REQUEST_MAX_BYTES
    )
    // Why ≥ 2.1×: a document of quotes, backslashes and newlines JSON-encodes at ~2× its size.
    expect(EMPLOYEE_TRANSCRIPT_REQUEST_MAX_BYTES).toBeGreaterThanOrEqual(
      EMPLOYEE_TRANSCRIPT_CONTENT_MAX_BYTES * 2.1
    )
    const worst = JSON.stringify('"\\\n'.repeat(EMPLOYEE_TRANSCRIPT_CONTENT_MAX_BYTES / 3))
    expect(Buffer.byteLength(worst)).toBeLessThanOrEqual(EMPLOYEE_TRANSCRIPT_REQUEST_MAX_BYTES)
    expect(consoleWorkflowRequestBudget('/api/app-health')).toBeUndefined()
    expect(consoleWorkflowRequestBudget('/api/team-memory/status')).toBeUndefined()
    expect(consoleWorkflowRequestBudget('/api/gtd/hub/api/handoffs')).toBe(14_100_000)
    expect(consoleWorkflowRequestBudget('/api/gtd/hub/api/handoffs/hth_abc/files/upload')).toBe(
      36 * 1024 * 1024
    )
  })
})
