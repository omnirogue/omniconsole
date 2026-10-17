import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionOwnerProbe } from '../../shared/agent-session-lease-adjudication'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { AgentSessionRecordStore } from './agent-session-record-store'
import type { AgentSessionReserveRequest } from './agent-session-reservation-admission'

const NOW = 1_800_000_000_000
const NATIVE: AgentSessionExecutionLocation = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'git-worktree'
}
const INDETERMINATE: AgentSessionOwnerProbe = { outcome: 'indeterminate', reason: 'no answer' }

let counter = 0
function operationId(now = NOW): string {
  counter += 1
  return `${now}-${String(counter).padStart(32, '0')}`
}

function reserveRequest(
  overrides: Partial<AgentSessionReserveRequest> = {}
): AgentSessionReserveRequest {
  return {
    sessionId: 'session-alpha',
    location: NATIVE,
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/home/dev/.codex' },
    runtimeKind: 'native',
    expectedFence: null,
    spawnToken: 'spawn-a',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: INDETERMINATE,
    operation: { callerKey: 'client-1', operationId: operationId(), fingerprint: 'fp-1' },
    now: NOW,
    ...overrides
  }
}

let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'omni-agent-session-store-options-'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function open(): Promise<AgentSessionRecordStore> {
  return AgentSessionRecordStore.open({ directory, hostId: 'local' })
}

describe('launch options on a fresh reservation', () => {
  it('records requested model and effort on create and leaves them off a bare create', async () => {
    const store = await open()
    const reserved = await store.reserveOwner(
      reserveRequest({
        sessionId: 'session-options',
        options: { model: 'gpt-6-astra', effort: 'xhigh' }
      })
    )
    expect(reserved.record.options).toEqual({ model: 'gpt-6-astra', effort: 'xhigh' })
    const bare = await store.reserveOwner(
      reserveRequest({
        sessionId: 'session-bare',
        operation: { callerKey: 'client-1', operationId: operationId(), fingerprint: 'fp-2' },
        options: {}
      })
    )
    expect(bare.record).not.toHaveProperty('options')
  })

  it('refuses an unbounded or non-string option map', async () => {
    const store = await open()
    await expect(
      store.reserveOwner(
        reserveRequest({
          sessionId: 'session-bad-options',
          options: { model: 42 } as unknown as Record<string, string>
        })
      )
    ).rejects.toThrow('agent_session_operation_invalid')
  })
})
