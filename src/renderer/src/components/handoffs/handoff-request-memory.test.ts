// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  retainPendingHandoff,
  recoverPendingHandoff,
  clearPendingHandoff,
  isRejectedHandoff
} from './handoff-request-memory'
import { WorkflowRequestError } from '@/lib/console-workflow-client'
beforeEach(() => localStorage.clear())
const body = {
  taskId: 'btk_sample01',
  title: 'Review',
  recipient: 'emp_two',
  action: 'review' as const,
  note: 'Check this original.',
  fileVersions: [],
  operationId: 'request_12345678'
}
describe('handoff recovery', () => {
  it('replays exactly across recovery, isolates people, and refuses changed payloads', () => {
    const request = { kind: 'send' as const, body }
    retainPendingHandoff('person-a', 'send:task', request)
    expect(recoverPendingHandoff('person-a', 'send:task').pending).toEqual(request)
    expect(recoverPendingHandoff('person-b', 'send:task').pending).toBeNull()
    expect(() =>
      retainPendingHandoff('person-a', 'send:task', {
        ...request,
        body: { ...body, note: 'Changed' }
      })
    ).toThrow('original request')
    clearPendingHandoff('person-a', 'send:task', 'another-operation')
    expect(recoverPendingHandoff('person-a', 'send:task').pending).toEqual(request)
    clearPendingHandoff('person-a', 'send:task', body.operationId)
    expect(recoverPendingHandoff('person-a', 'send:task').pending).toBeNull()
  })
  it('does not store attachment contents and blocks corrupt saved requests', () => {
    retainPendingHandoff('a', 'return:task', {
      kind: 'return',
      body: {
        threadId: 'hth_sample',
        baseVersionId: 'hfv_old',
        note: 'Updated',
        operationId: 'return_12345678',
        file: { name: 'proposal.docx', sha256: 'a'.repeat(64), size: 4 }
      }
    } as never)
    expect(localStorage.getItem(localStorage.key(0)!)).not.toContain('contentBase64')
    localStorage.setItem(localStorage.key(0)!, '{broken')
    expect(recoverPendingHandoff('a', 'return:task')).toMatchObject({
      pending: null,
      error: expect.stringContaining('could not be recovered')
    })
  })
  it('never turns uncertainty into a new operation', () => {
    for (const status of [409, 408, 429, 500, 502]) {
      expect(
        isRejectedHandoff(
          new WorkflowRequestError({ status, code: 'checking_delivery', message: 'Check result' })
        )
      ).toBe(false)
    }
    expect(isRejectedHandoff(new Error('connection lost'))).toBe(false)
    expect(
      isRejectedHandoff(
        new WorkflowRequestError({ status: 403, code: 'forbidden', message: 'Access denied' })
      )
    ).toBe(true)
  })
})
