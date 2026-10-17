// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  approveSessionPullRequests,
  resetSessionApprovalsForTest,
  useApprovedSessionPullRequests,
  withdrawSessionPullRequestApproval
} from './session-approvals'

beforeEach(() => {
  window.localStorage.clear()
  resetSessionApprovalsForTest()
})

describe('session approvals', () => {
  it('keeps the person’s approvals on this computer and tells the card', () => {
    const { result } = renderHook(() => useApprovedSessionPullRequests())
    expect(result.current.size).toBe(0)
    act(() => approveSessionPullRequests(['omnirogue/omnirogue#1002']))
    expect(result.current.has('omnirogue/omnirogue#1002')).toBe(true)
    expect(JSON.parse(window.localStorage.getItem('omni.sessionProgress.approved.v1')!)).toEqual([
      'omnirogue/omnirogue#1002'
    ])
    act(() => withdrawSessionPullRequestApproval(['omnirogue/omnirogue#1002']))
    expect(result.current.size).toBe(0)
  })

  it('reads approvals saved earlier and survives unreadable storage', () => {
    window.localStorage.setItem('omni.sessionProgress.approved.v1', '["a/b#1", 7]')
    const { result } = renderHook(() => useApprovedSessionPullRequests())
    expect([...result.current]).toEqual(['a/b#1'])

    resetSessionApprovalsForTest()
    window.localStorage.setItem('omni.sessionProgress.approved.v1', '{not json')
    const again = renderHook(() => useApprovedSessionPullRequests())
    expect(again.result.current.size).toBe(0)
  })
})
