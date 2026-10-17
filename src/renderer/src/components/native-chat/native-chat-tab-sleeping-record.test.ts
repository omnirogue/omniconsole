import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import { findTabSleepingAgentRecord } from './native-chat-tab-sleeping-record'

function record(overrides: Partial<SleepingAgentSessionRecord>): SleepingAgentSessionRecord {
  return {
    paneKey: 't1:leaf-1',
    worktreeId: 'wt',
    agent: 'codex',
    providerSession: { key: 'session_id', id: 'thread-1' },
    prompt: '',
    state: 'done',
    capturedAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('findTabSleepingAgentRecord', () => {
  it('prefers the exact pane, then the newest record under the tab', () => {
    const records = {
      't1:leaf-1': record({ updatedAt: 5 }),
      't1:leaf-2': record({ paneKey: 't1:leaf-2', updatedAt: 9 }),
      't2:leaf-1': record({ paneKey: 't2:leaf-1', updatedAt: 99 })
    }
    expect(findTabSleepingAgentRecord(records, 't1', 't1:leaf-1')?.updatedAt).toBe(5)
    expect(findTabSleepingAgentRecord(records, 't1')?.paneKey).toBe('t1:leaf-2')
    expect(findTabSleepingAgentRecord(records, 't3')).toBeNull()
  })

  it('matches legacy records that only carry the tab id', () => {
    const records = { 'legacy-7': record({ paneKey: 'legacy-7', tabId: 't1' }) }
    expect(findTabSleepingAgentRecord(records, 't1')?.paneKey).toBe('legacy-7')
  })
})
