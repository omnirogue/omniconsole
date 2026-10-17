import { describe, expect, it } from 'vitest'
import { localWorkflowAttemptCost } from './local-workflow-attempt-cost'
import { SEATS } from './graph/graph-test-harness'

const attempt = (id: string, state = 'failed', receipt = {}) => ({
  id,
  call_id: 'find/r1/a0',
  ordinal: 1,
  state,
  receipt_json: JSON.stringify(receipt)
})

describe('72: billed terminal attempts', () => {
  it('adds failed, cancelled and accepted bills exactly once', () => {
    const attempts = [
      attempt('failed'),
      attempt('cancelled', 'cancelled'),
      attempt('accepted', 'accepted')
    ]
    const cost = localWorkflowAttemptCost(attempts, SEATS[0]!, (entry) =>
      entry.id === 'accepted' ? 2 : 0.5
    )
    expect(cost).toEqual({ usd: 3, source: 'cli' })
  })
  it('keeps missing launched bills partial and definite no-launch refusals out of the bill', () => {
    const cost = localWorkflowAttemptCost(
      [attempt('billed'), attempt('unknown'), attempt('refused', 'failed', { noLaunch: true })],
      SEATS[0]!,
      (entry) => (entry.id === 'billed' ? 1 : undefined)
    )
    expect(cost).toEqual({ usd: 1, source: 'cli', partial: true })
    expect(
      localWorkflowAttemptCost([attempt('unknown')], SEATS[0]!, () => undefined)
    ).toBeUndefined()
  })
})
