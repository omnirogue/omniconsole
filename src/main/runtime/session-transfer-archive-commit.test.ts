import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainEvent } from 'electron'
import {
  bindTransferArchiveCommit,
  registerTransferArchiveCommit
} from './session-transfer-archive-commit'

const state = vi.hoisted(() => ({
  handler: null as null | ((event: IpcMainEvent, token: unknown, scope: unknown) => void)
}))
vi.mock('./runtime-desktop-surface', () => {
  const surface = {
    onIpc: (_channel: string, handler: typeof state.handler) => {
      state.handler = handler
    }
  }
  return { getRuntimeDesktopSurface: () => surface }
})
vi.mock('./session-transfer-archive-decisions', () => ({
  commitArchiveDecision: (_id: string, _keys: string[], scope: string, guard: () => boolean) =>
    scope === 'omni.session-sidebar-view.v1:person' && guard(),
  pendingArchiveDecisions: () => [],
  acknowledgeArchiveDecision: () => true
}))
afterEach(() => vi.useRealTimers())
function fixture(guard = () => true) {
  const win = { webContents: {} } as BrowserWindow
  const commit = registerTransferArchiveCommit(guard, Date.now() + 1000, 'op', ['source'])
  bindTransferArchiveCommit(win, commit.token)
  const request = (sender = win.webContents) => {
    const event = { sender, returnValue: undefined } as unknown as IpcMainEvent
    state.handler!(event, commit.token, 'omni.session-sidebar-view.v1:person')
    return event.returnValue
  }
  return { commit, request }
}

describe('renderer archive commit gate', () => {
  it('rechecks the batch at consumption and permits the exact window once', () => {
    const guard = vi.fn(() => true)
    const { request, commit } = fixture(guard)
    expect(request({} as BrowserWindow['webContents'])).toBe(false)
    expect(request()).toBe(true)
    expect(request()).toBe(false)
    expect(guard).toHaveBeenCalledOnce()
    commit.close()
  })

  it('late source activity invalidates a queued renderer request', () => {
    let current = true
    const { request, commit } = fixture(() => current)
    current = false
    expect(request()).toBe(false)
    commit.close()
  })

  it('closed and expired requests still receive synchronous refusals', () => {
    vi.useFakeTimers()
    const expired = fixture()
    vi.advanceTimersByTime(1000)
    expect(expired.request()).toBe(false)
    const closed = fixture()
    closed.commit.close()
    expect(closed.request()).toBe(false)
  })
})
