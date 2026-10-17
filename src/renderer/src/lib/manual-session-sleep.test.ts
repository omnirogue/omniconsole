import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { isPassiveCompletedHibernationEvidence } from './sleeping-agent-pane-ownership'
import {
  consumeManualSessionSleepExit,
  markManualSessionSleepExit,
  toManualSessionSleepRecord
} from './manual-session-sleep'

describe('manual session sleep', () => {
  it('turns a working capture into a passive, tab-open-only record that keeps its identity', () => {
    const captured: SleepingAgentSessionRecord = {
      paneKey: 'tab:leaf',
      worktreeId: 'wt',
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'abc' },
      prompt: 'fix it',
      state: 'working',
      capturedAt: 2,
      updatedAt: 2,
      interrupted: true,
      origin: 'worktree-sleep'
    }
    const record = toManualSessionSleepRecord(captured)
    expect(record).toMatchObject({
      state: 'done',
      restoreOnTabOpenOnly: true,
      providerSession: { key: 'session_id', id: 'abc' },
      origin: 'worktree-sleep'
    })
    expect(record.interrupted).toBeUndefined()
    expect(isPassiveCompletedHibernationEvidence(record)).toBe(true)
  })

  it('reads the exit mark once', () => {
    markManualSessionSleepExit('pty-9')
    expect(consumeManualSessionSleepExit('pty-9')).toBe(true)
    expect(consumeManualSessionSleepExit('pty-9')).toBe(false)
  })
})
