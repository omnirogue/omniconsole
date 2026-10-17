import { describe, expect, it } from 'vitest'

import { isAgentSessionRecord, type AgentSessionLease } from '../../shared/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import {
  isNativePeerInboxReceipt,
  type NativePeerInboxBinding,
  type NativePeerInboxReceipt
} from '../../shared/native-peer-inbox-binding'
import { replaceNativePeerInboxRecord } from './native-peer-inbox-record'

function binding(): NativePeerInboxBinding {
  return {
    key: 'peer-scope-native-generation-7',
    peerSessionId: 'peer-recipient-1',
    employeeId: 'employee-1',
    companyId: 'company-1',
    projectId: 'project-1',
    taskId: 'task-1',
    apiOrigin: 'https://hub.example.test',
    tokenFile: '/private/peer/recipient.token',
    runtimeId: 'runtime-1',
    terminalHandle: 'terminal:1',
    ptyId: 'pty-1',
    incarnation: 'incarnation-1',
    executionHostId: 'local',
    workspaceId: 'workspace-1',
    paneKey: 'pane-1',
    provider: 'claude',
    providerSessionId: 'provider-session-alpha-1',
    nativeSessionId: 'session-alpha-1',
    runtimeFence: 7,
    wakeConsent: true
  }
}

function receipt(
  outcome: NonNullable<NativePeerInboxReceipt['attempt']>['outcome'] | null = null
): NativePeerInboxReceipt {
  return { binding: binding(), attempt: outcome ? { nonce: 'attempt-1', outcome } : null }
}

function replacement(
  next: NativePeerInboxReceipt,
  expected: NativePeerInboxReceipt | undefined = undefined
) {
  return {
    sessionId: 'session-alpha-1',
    fence: 7,
    expected,
    next,
    now: 35_000
  }
}

describe('native peer inbox durable record admission', () => {
  it('adds metadata to the live TUI lease without mutating its caller-owned input', () => {
    const original = agentSessionRecordFixture()
    const next = receipt('uncertain')
    const updated = replaceNativePeerInboxRecord(original, replacement(next))
    expect(updated.updatedAt).toBe(35_000)
    expect(updated.peerInbox).toEqual(next)
    expect(updated.lease).toBe(original.lease)
    expect(original.peerInbox).toBeUndefined()
    next.binding.projectId = 'caller-mutated'
    next.attempt!.nonce = 'caller-mutated'
    expect(updated.peerInbox?.binding.projectId).toBe('project-1')
    expect(updated.peerInbox?.attempt?.nonce).toBe('attempt-1')
    expect(isAgentSessionRecord(updated)).toBe(true)
  })

  it.each([
    { runtimeKind: 'native' },
    { claimStatus: 'reserved' },
    { claimStatus: 'conflicted' },
    { claimStatus: 'released' },
    { unreconciled: true },
    { handoffStage: 'preparing' },
    { handoffStage: 'old-owner-stopped' },
    { handoffStage: 'new-owner-proving' },
    { handoffStage: 'recovering' },
    { handoffStage: 'manual-recovery' },
    { runtimeFence: 8 }
  ] satisfies Partial<AgentSessionLease>[])(
    'refuses metadata mutation without the exact live TUI owner: %j',
    (lease) => {
      const record = agentSessionRecordFixture(agentSessionLeaseFixture(lease))
      expect(() => replaceNativePeerInboxRecord(record, replacement(receipt()))).toThrow(
        'peer_inbox_ownership_unverifiable'
      )
      expect(record.peerInbox).toBeUndefined()
    }
  )

  it('refuses a different native session even when the fence matches', () => {
    const record = agentSessionRecordFixture()
    expect(() =>
      replaceNativePeerInboxRecord(record, {
        ...replacement(receipt()),
        sessionId: 'session-beta-2'
      })
    ).toThrow('peer_inbox_ownership_unverifiable')
  })

  it.each(['nativeSessionId', 'runtimeFence'] as const)(
    'rejects a receipt bound to a different %s',
    (field) => {
      const next = receipt()
      if (field === 'nativeSessionId') {
        next.binding.nativeSessionId = 'session-beta-2'
      } else {
        next.binding.runtimeFence = 8
      }
      expect(() =>
        replaceNativePeerInboxRecord(agentSessionRecordFixture(), replacement(next))
      ).toThrow('peer_inbox_binding_invalid')
    }
  )

  it('rejects a stale compare-and-swap receipt instead of overwriting a new attempt', () => {
    const record = agentSessionRecordFixture()
    const old = receipt()
    record.peerInbox = receipt('uncertain')
    expect(() => replaceNativePeerInboxRecord(record, replacement(receipt(), old))).toThrow(
      'peer_inbox_binding_changed'
    )
    expect(record.peerInbox.attempt?.outcome).toBe('uncertain')
  })

  it.each(['uncertain', 'submitted'] as const)(
    'does not discard or replace a %s attempt',
    (outcome) => {
      const record = agentSessionRecordFixture()
      record.peerInbox = receipt(outcome)
      const otherBinding = receipt(outcome)
      otherBinding.binding.key = 'different-peer-binding'
      const otherAttempt = receipt(outcome)
      otherAttempt.attempt!.nonce = 'attempt-2'
      for (const next of [receipt(), otherBinding, otherAttempt]) {
        expect(() =>
          replaceNativePeerInboxRecord(record, replacement(next, record.peerInbox))
        ).toThrow('peer_inbox_submission_unresolved')
      }
    }
  )

  it.each(['projectId', 'peerSessionId', 'ptyId', 'providerSessionId', 'tokenFile'] as const)(
    'rejects unresolved binding changes to %s even if the supplied key is reused',
    (field) => {
      const record = agentSessionRecordFixture()
      record.peerInbox = receipt('uncertain')
      const next = receipt('uncertain')
      next.binding[field] = 'different-value'
      expect(() =>
        replaceNativePeerInboxRecord(record, replacement(next, record.peerInbox))
      ).toThrow('peer_inbox_submission_unresolved')
    }
  )

  it('records an authoritative outcome for the same binding and attempt', () => {
    const record = agentSessionRecordFixture()
    record.peerInbox = receipt('uncertain')
    const updated = replaceNativePeerInboxRecord(
      record,
      replacement(receipt('completed'), record.peerInbox)
    )
    expect(updated.peerInbox?.attempt).toEqual({ nonce: 'attempt-1', outcome: 'completed' })
  })

  it.each(['completed', 'not-written'] as const)(
    'allows clearing a %s receipt before the next attempt',
    (outcome) => {
      const record = agentSessionRecordFixture()
      record.peerInbox = receipt(outcome)
      const updated = replaceNativePeerInboxRecord(record, replacement(receipt(), record.peerInbox))
      expect(updated.peerInbox?.attempt).toBeNull()
      expect(record.peerInbox.attempt?.outcome).toBe(outcome)
    }
  )
})

describe('persisted native peer inbox receipt validation', () => {
  it.each([null, undefined, [], {}, { binding: binding() }])(
    'rejects absent or structurally invalid receipts: %j',
    (value) => {
      expect(isNativePeerInboxReceipt(value)).toBe(false)
      if (value !== undefined) {
        expect(isAgentSessionRecord({ ...agentSessionRecordFixture(), peerInbox: value })).toBe(
          false
        )
      }
    }
  )

  it.each([
    { nonce: '', outcome: 'uncertain' },
    { nonce: 'x'.repeat(129), outcome: 'uncertain' },
    { nonce: 3, outcome: 'uncertain' },
    { nonce: 'attempt-1', outcome: 'acknowledged' },
    { nonce: 'attempt-1' }
  ])('rejects invalid persisted attempt metadata: %j', (attempt) => {
    const value = { binding: binding(), attempt }
    expect(isNativePeerInboxReceipt(value)).toBe(false)
    expect(isAgentSessionRecord({ ...agentSessionRecordFixture(), peerInbox: value })).toBe(false)
  })

  it.each([
    { projectId: '' },
    { projectId: 'x'.repeat(513) },
    { employeeId: 'employee\nspoof' },
    { tokenFile: '/private/peer/\0token' },
    { tokenFile: 'x'.repeat(4097) },
    { provider: 'other' },
    { runtimeFence: -1 },
    { runtimeFence: 0.5 },
    { wakeConsent: 'true' }
  ])('rejects invalid persisted bindings: %j', (overrides) => {
    const value = { binding: { ...binding(), ...overrides }, attempt: null }
    expect(isNativePeerInboxReceipt(value)).toBe(false)
    expect(isAgentSessionRecord({ ...agentSessionRecordFixture(), peerInbox: value })).toBe(false)
  })

  it('does not mistake valid persisted metadata for an automatic wake grant', () => {
    const value = receipt()
    value.binding.wakeConsent = false
    expect(isNativePeerInboxReceipt(value)).toBe(true)
    expect(isAgentSessionRecord({ ...agentSessionRecordFixture(), peerInbox: value })).toBe(true)
  })
})
