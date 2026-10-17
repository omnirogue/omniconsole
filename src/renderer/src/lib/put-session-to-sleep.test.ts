import { describe, expect, it, vi } from 'vitest'

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))

import { consumeManualSessionSleepExit } from './manual-session-sleep'
import { putSidebarSessionToSleep } from './put-session-to-sleep'
import type { SessionSleepPlan } from './session-sleep-target'

const ROW = { kind: 'terminal' as const, worktreeId: 'wt', tabId: 'tab', paneKey: 'tab:leaf' }
const TARGET = { worktreeId: 'wt', tabId: 'tab', leafId: 'leaf', paneKey: 'tab:leaf', ptyId: 'pty' }
const READY: SessionSleepPlan = { ok: true, target: TARGET }

describe('putSidebarSessionToSleep', () => {
  it('kills nothing when the row cannot sleep', async () => {
    const shutdownPane = vi.fn()
    const result = await putSidebarSessionToSleep(ROW, {
      plan: () => ({ ok: false, reason: 'not-resumable' }),
      shutdownPane
    })
    expect(result.ok).toBe(false)
    expect(result.message).toBeTruthy()
    expect(shutdownPane).not.toHaveBeenCalled()
  })

  it('marks the exit as a person’s sleep before the kill and uses the manual capture', async () => {
    const shutdownPane = vi.fn(async () => {
      // Why: the pane's exit handler may run during the kill; the mark must already be there.
      expect(consumeManualSessionSleepExit('pty')).toBe(true)
    })
    expect(await putSidebarSessionToSleep(ROW, { plan: () => READY, shutdownPane })).toEqual({
      ok: true
    })
    expect(shutdownPane).toHaveBeenCalledWith('wt', {
      tabId: 'tab',
      leafId: 'leaf',
      paneKey: 'tab:leaf',
      ptyId: 'pty',
      captureMode: 'manual-session-sleep'
    })
  })

  it('reports a missing resume record as a refusal and clears the exit mark', async () => {
    const result = await putSidebarSessionToSleep(ROW, {
      plan: () => READY,
      shutdownPane: vi.fn(async () => {
        throw new Error('agent_hibernation_capture_missing')
      })
    })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/resumable/)
    expect(consumeManualSessionSleepExit('pty')).toBe(false)
  })
})
