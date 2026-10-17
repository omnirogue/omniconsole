import { describe, expect, it } from 'vitest'
import { AGENT_STATUS_STALE_AFTER_MS, isFreshNonDoneAgentStatus } from './agent-status-freshness'

describe('execution evidence freshness', () => {
  const now = AGENT_STATUS_STALE_AFTER_MS + 100
  it('does not renew old evidence when delivery advances', () => {
    expect(
      isFreshNonDoneAgentStatus({ state: 'working', updatedAt: now, evidenceObservedAt: 1 }, now)
    ).toBe(false)
  })
  it('uses the receiving clock despite remote clock skew', () => {
    for (const updatedAt of [-1e12, 1e12]) {
      expect(
        isFreshNonDoneAgentStatus(
          { state: 'working', updatedAt, mirroredEvidenceReceivedAt: 1 },
          now
        )
      ).toBe(false)
      expect(
        isFreshNonDoneAgentStatus(
          { state: 'working', updatedAt, mirroredEvidenceReceivedAt: now },
          now
        )
      ).toBe(true)
    }
  })
  it('keeps a connected host-owned quiet turn live until ownership is revoked', () => {
    expect(
      isFreshNonDoneAgentStatus({ state: 'working', updatedAt: 1, structuredHostOwned: true }, now)
    ).toBe(true)
    expect(isFreshNonDoneAgentStatus({ state: 'working', updatedAt: 1 }, now)).toBe(false)
    expect(
      isFreshNonDoneAgentStatus({ state: 'done', updatedAt: now, structuredHostOwned: true }, now)
    ).toBe(false)
    expect(
      isFreshNonDoneAgentStatus(
        {
          state: 'working',
          updatedAt: now,
          structuredHostOwned: true,
          restoredUnconfirmed: true
        },
        now
      )
    ).toBe(false)
  })
})
