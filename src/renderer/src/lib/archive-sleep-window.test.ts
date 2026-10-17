import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  sleep: vi.fn(async () => ({ ok: true }))
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}), subscribe: () => () => {} } }))
vi.mock('@/store/session-sidebar-view', () => ({
  useSessionSidebarView: { getState: () => ({ loaded: true, archived: [] }) }
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('./put-session-to-sleep', () => ({ putSidebarSessionToSleep: mocks.sleep }))

import type { AppState } from '@/store/types'
import { SESSION_ORGANIZATION_RPC } from '../../../shared/session-organization-change'
import { windowArchiveSleepDeps } from './archive-sleep-window'
import { setDriverForPty } from './pane-manager/mobile-driver-state'
import type { SidebarSession } from './sidebar-sessions'
import { registerTerminalPaneVisibility } from './terminal-pane-visibility-registry'

const session = {
  rowKey: 'row-1',
  sessionKey: 'claude:abc',
  worktreeId: 'wt',
  hostId: 'local',
  tabId: 'tab-1',
  paneKey: 'tab-1:leaf-1',
  kind: 'terminal',
  label: 'Fix the build',
  workspaceLabel: 'repo',
  agent: 'Claude Code',
  unavailable: false,
  folderKeyMigration: null
} as SidebarSession

describe('the window’s archive-sleep readings and actions', () => {
  it('reads "on screen" from the pane’s own ref and a person from the driver seat', () => {
    const deps = windowArchiveSleepDeps()
    const state = { lastTerminalInputAtByPaneKey: { 'tab-1:leaf-1': 5 } } as unknown as AppState
    const ref = { current: true }
    const off = registerTerminalPaneVisibility('tab-1', ref)
    const touch = deps.touch(state, 1_000)
    expect(touch.now).toBe(1_000)
    expect(touch.inputAtByPaneKey['tab-1:leaf-1']).toBe(5)
    expect(touch.isTabVisible('tab-1')).toBe(true)
    ref.current = false
    expect(touch.isTabVisible('tab-1')).toBe(false)
    off()
    expect(touch.isPtyDriven('pty-1')).toBe(false)
    expect(touch.ptyDriverReleasedAt('pty-1')).toBeUndefined()
    setDriverForPty('pty-1', { kind: 'mobile', clientId: 'phone' })
    expect(touch.isPtyDriven('pty-1')).toBe(true)
    const before = Date.now()
    setDriverForPty('pty-1', { kind: 'idle' })
    expect(touch.isPtyDriven('pty-1')).toBe(false)
    // G2: letting go of the seat leaves the time a person last held it.
    expect(touch.ptyDriverReleasedAt('pty-1')).toBeGreaterThanOrEqual(before)
  })

  it('asks this computer’s main for its reading, and sleeps through the row’s Put to sleep', async () => {
    const deps = windowArchiveSleepDeps()
    mocks.rpc.mockResolvedValueOnce({ clear: true, state: 'idle' })
    expect(await deps.readHost(session)).toEqual({ clear: true, state: 'idle' })
    expect(mocks.rpc).toHaveBeenCalledWith(
      { kind: 'local' },
      SESSION_ORGANIZATION_RPC.archiveSleepReading,
      { paneKey: 'tab-1:leaf-1', tabId: 'tab-1', worktreeId: 'wt' },
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    )
    expect(await deps.readHost({ ...session, paneKey: null })).toEqual({
      clear: false,
      keep: 'unreadable'
    })
    await deps.sleep(session)
    expect(mocks.sleep).toHaveBeenCalledWith(session)
  })

  it('reports a History line main could not write', async () => {
    const deps = windowArchiveSleepDeps()
    const note = {
      sessionKey: 'claude:abc',
      paneKey: 'tab-1:leaf-1',
      tabId: 'tab-1',
      title: 'Fix the build',
      via: 'person' as const,
      trigger: 'archive' as const,
      evidence: 'archive: Done'
    }
    mocks.rpc.mockResolvedValueOnce({ auditError: 'disk full' })
    await expect(deps.audit(note)).rejects.toThrow('disk full')
    mocks.rpc.mockResolvedValueOnce({})
    await expect(deps.audit(note)).resolves.toBeUndefined()
  })

  it('runs and cancels its timer', () => {
    vi.useFakeTimers()
    try {
      const deps = windowArchiveSleepDeps()
      const run = vi.fn()
      const cancel = deps.setTimer(run, 1_000)
      cancel()
      vi.advanceTimersByTime(2_000)
      expect(run).not.toHaveBeenCalled()
      deps.setTimer(run, 1_000)
      vi.advanceTimersByTime(1_000)
      expect(run).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
