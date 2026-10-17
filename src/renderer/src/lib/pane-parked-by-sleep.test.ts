import { describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { isPaneParkedBySleep } from './pane-parked-by-sleep'

const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = `tab-1:${LEAF}`

function record(patch: Partial<SleepingAgentSessionRecord> = {}): SleepingAgentSessionRecord {
  return {
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'w',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'conv' },
    prompt: '',
    state: 'done',
    capturedAt: 1,
    updatedAt: 1,
    restoreOnTabOpenOnly: true,
    resumeOnFirstReveal: true,
    ...patch
  }
}

function state(recordedPty: string | null, livePtys: string[] = []) {
  return {
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: recordedPty ? { [LEAF]: recordedPty } : {}
      }
    },
    ptyIdsByTabId: { 'tab-1': livePtys }
  } as never
}

describe('a pane parked by sleep', () => {
  it('needs the automatic-sleep checkpoint and the daemon saying its PTY is gone', async () => {
    expect(
      await isPaneParkedBySleep(
        state('pty-1'),
        record(),
        vi.fn(async () => false)
      )
    ).toBe(true)
    expect(await isPaneParkedBySleep(state(null), record(), undefined)).toBe(true)
  })

  it('refuses a daemon-kept agent, an unknown answer, or a quit checkpoint', async () => {
    expect(
      await isPaneParkedBySleep(
        state('pty-1'),
        record(),
        vi.fn(async () => true)
      )
    ).toBe(false)
    expect(
      await isPaneParkedBySleep(
        state('pty-1'),
        record(),
        vi.fn(async () => null)
      )
    ).toBe(false)
    expect(await isPaneParkedBySleep(state('pty-1'), record(), undefined)).toBe(false)
    expect(
      await isPaneParkedBySleep(
        state(null),
        record({ origin: 'quit', resumeOnFirstReveal: undefined, state: 'working' }),
        undefined
      )
    ).toBe(false)
  })

  it('looks only at its own leaf in a split tab', async () => {
    expect(
      await isPaneParkedBySleep(
        state('pty-1', ['pty-other']),
        record(),
        vi.fn(async () => false)
      )
    ).toBe(true)
    expect(
      await isPaneParkedBySleep(
        state('pty-1', ['pty-1']),
        record(),
        vi.fn(async () => false)
      )
    ).toBe(false)
  })
})
