import { describe, expect, it, vi } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../shared/structured-agent-session-projection'
import { createStructuredSessionOutcomeAccess } from './structured-agent-session-outcome-authority'

vi.mock('../../../shared/structured-agent-session-outcome-observation', () => ({
  observeStructuredAgentSessionOutcome: () => ({ ready: true, version: 'complete-reply-receipt' })
}))
function fixture() {
  const record = agentSessionRecordFixture(agentSessionLeaseFixture({ runtimeKind: 'native' }))
  const session = {
    params: { location: record.location },
    fence: record.lease.runtimeFence,
    hasProviderChild: true,
    journal: { snapshot: () => ({}) }
  }
  let now = 40_000
  const access = createStructuredSessionOutcomeAccess(() => ({
    sessions: new Map([[record.sessionId, session]]) as never,
    store: { getRecord: () => record } as never,
    now
  }))
  const paneKey = structuredAgentSessionPaneKey(
    structuredAgentSessionTabId(record.sessionId),
    record.sessionId
  )
  return {
    record,
    session,
    read: () => access.transferOwnership(paneKey, record.location.workspaceId),
    time: (value: number) => {
      now = value
    }
  }
}

describe('structured transfer ownership at archive commit', () => {
  it('binds a complete reply to the exact live native fence', () => {
    const f = fixture()
    expect(f.read()).toBe(
      JSON.stringify([f.record.sessionId, f.record.lease.runtimeFence, 'complete-reply-receipt'])
    )
  })

  it.each([
    'expired',
    'released',
    'replaced',
    'unreconciled',
    'handoff',
    'provider gone',
    'remote'
  ])('refuses %s ownership despite unchanged completed reply', (change) => {
    const f = fixture()
    if (change === 'expired') {
      f.time(f.record.lease.leaseDeadlineAt)
    }
    if (change === 'released') {
      f.record.lease.claimStatus = 'released'
    }
    if (change === 'replaced') {
      f.session.fence += 1
    }
    if (change === 'unreconciled') {
      f.record.lease.unreconciled = true
    }
    if (change === 'handoff') {
      f.record.lease.handoffStage = 'preparing'
    }
    if (change === 'provider gone') {
      f.session.hasProviderChild = false
    }
    if (change === 'remote') {
      f.record.location.executionHostId = 'ssh:other-host'
    }
    expect(f.read()).toBeNull()
  })
})
