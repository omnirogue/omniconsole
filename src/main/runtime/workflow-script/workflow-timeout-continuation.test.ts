import { describe, expect, it } from 'vitest'
import { WorkflowTimeoutContinuation } from './workflow-timeout-continuation'
import type { WorkflowProgramCall } from './workflow-program-context'
import { WORKFLOW_FROZEN_TIMEOUT_MS, WORKFLOW_MAX_CALL_TIMEOUT_MS } from './workflow-call-timeout'

const call: WorkflowProgramCall = {
  id: 'call',
  seatId: 'seat',
  dependencies: [],
  prompt: 'Question',
  schema: { type: 'object' },
  validateSemantics: () => null
}
const timedOut = { code: null, signal: null, timedOut: true, stdout: '', stderr: '' }

describe('effective timeout continuation budget', () => {
  it.each([
    [undefined, WORKFLOW_FROZEN_TIMEOUT_MS / 2],
    [10000, 5000],
    [2 * WORKFLOW_MAX_CALL_TIMEOUT_MS, WORKFLOW_MAX_CALL_TIMEOUT_MS / 2],
    [0, WORKFLOW_FROZEN_TIMEOUT_MS / 2]
  ])('shortens a requested budget of %s to %s', (timeoutMs, retryMs) => {
    const original = { ...call, timeoutMs }
    const retry = new WorkflowTimeoutContinuation(original)
    expect(retry.call()).toBe(original)
    retry.retain(timedOut)
    expect(retry.call().timeoutMs).toBe(retryMs)
    expect(retry.call().prompt).toContain('earlier attempt timed out')
  })
})
