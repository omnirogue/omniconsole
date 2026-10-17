import { describe, expect, it } from 'vitest'
import { WORKFLOW_MAX_CALL_TIMEOUT_MS, workflowCallTimeoutMs } from './workflow-call-timeout'

describe('workflow call timeout', () => {
  it('rounds and caps a program timeout, and leaves a call without one to the launch default', () => {
    expect(workflowCallTimeoutMs(15 * 60_000)).toBe(15 * 60_000)
    expect(workflowCallTimeoutMs(59_999.6)).toBe(60_000)
    expect(workflowCallTimeoutMs(1)).toBe(1)
    expect(workflowCallTimeoutMs(3 * 60 * 60_000)).toBe(WORKFLOW_MAX_CALL_TIMEOUT_MS)
    expect(WORKFLOW_MAX_CALL_TIMEOUT_MS).toBe(60 * 60_000)
    for (const requested of [undefined, 0, 0.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(workflowCallTimeoutMs(requested)).toBeUndefined()
    }
  })
})
