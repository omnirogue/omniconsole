import { describe, expect, it } from 'vitest'
import { LAUNCH_TRIGGERS } from './launch-trigger'
import { normalizeLaunchCause, LAUNCH_REFERENCE_KEYS } from './launch-cause'

const required = [
  'person-reveal',
  'background-mount',
  'browser-lease',
  'mobile-wake',
  'restore-interrupted',
  'cold-restore-mount',
  'cli',
  'hibernation-wake',
  'new',
  'unknown',
  'automation',
  'orchestration-worker',
  'coordinator-shell',
  'capacity-recovery',
  'session-transfer',
  'session-handoff',
  'outcome',
  'workflow',
  'steward-resume',
  'agent-session-create',
  'agent-session-resume',
  'session-resume',
  'session-prep',
  'worktree-create',
  'dashboard-popout',
  'worktree-background-terminals',
  'codex-pane-restart',
  'agent-team',
  'ssh-pane-recovery',
  'paired-client',
  'terminal-create',
  'terminal-split',
  'session-tabs-create',
  'renderer-spawn'
]
const valid = {
  trigger: 'cli',
  reference: { automationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  actor: {
    kind: 'paired-device',
    deviceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    clientKind: 'runtime',
    paneKey: '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
    terminalHandle: 'term_55555555-5555-4555-8555-555555555555'
  },
  requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  parentPaneKey: '33333333-3333-4333-8333-333333333333:44444444-4444-4444-8444-444444444444'
}

describe('launch cause contract', () => {
  it('contains the exact required vocabulary', () => {
    expect([...LAUNCH_TRIGGERS].sort()).toEqual([...required].sort())
  })
  it('preserves every allowed cause field', () => {
    expect(normalizeLaunchCause(valid)).toEqual(valid)
  })
  it('replaces an unknown trigger while retaining valid owner ids', () => {
    expect(normalizeLaunchCause({ ...valid, trigger: 'free text' })).toEqual({
      ...valid,
      trigger: 'unknown'
    })
  })
  it('drops keys outside all fixed lists', () => {
    expect(
      normalizeLaunchCause({
        ...valid,
        command: 'secret',
        reference: { automationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', freeText: 'secret' },
        actor: { ...valid.actor, clientId: 'bearer-secret' }
      })
    ).toEqual(valid)
    expect(LAUNCH_REFERENCE_KEYS).toEqual([
      'automationId',
      'automationRunId',
      'orchestrationTaskId',
      'orchestrationDispatchId',
      'orchestrationRunId',
      'outcomeChainId',
      'workflowRunId',
      'recoveryId',
      'transferId',
      'sessionPrepBatchId',
      'agentSessionId',
      'buildReviewRunId',
      'consoleJobId'
    ])
  })
  it.each(['line\nbreak', 'control\u0000byte', 'a'.repeat(257), '', 'tab\tvalue'])(
    'drops unsafe string %j',
    (unsafe) => {
      expect(
        normalizeLaunchCause({
          trigger: 'cli',
          reference: { automationId: unsafe },
          actor: { kind: 'app', deviceId: unsafe },
          requestId: unsafe,
          parentPaneKey: unsafe
        })
      ).toEqual({ trigger: 'cli', actor: { kind: 'app' } })
    }
  )
  it('is total for non objects and still recognizes a valid object', () => {
    for (const value of [null, undefined, false, 42, 'cli', []]) {
      expect(normalizeLaunchCause(value)).toEqual({ trigger: 'unknown' })
    }
    expect(normalizeLaunchCause({ trigger: 'cli' })).toEqual({ trigger: 'cli' })
  })
})

it('retains generated structured session identities and rejects readable private text', () => {
  const agentSessionId = 'claude_11111111_1111_4111_8111_111111111111'
  expect(
    normalizeLaunchCause({ trigger: 'agent-session-create', reference: { agentSessionId } })
      .reference
  ).toEqual({ agentSessionId })
  expect(
    normalizeLaunchCause({
      trigger: 'agent-session-create',
      reference: { agentSessionId: 'claude_private_account_path' }
    }).reference
  ).toBeUndefined()
})
