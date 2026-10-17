import { describe, expect, it, vi } from 'vitest'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import {
  callerDrivesHostWindow,
  SESSION_SHOW_OLD_WINDOW_SUMMARY,
  SESSION_SHOW_REMOTE_SUMMARY,
  showSession
} from './session-manage-show'

const ROW = {
  rowKey: 'row-1',
  viewKey: 'row-1',
  paneKey: 'tab-1:leaf-1',
  tabId: 'tab-1',
  kind: 'terminal',
  title: 'Ads',
  worktreeId: 'wt-1'
} as SessionManageSidebarRow

function deps(reply: unknown) {
  return {
    readRows: vi.fn(async () => [ROW]),
    relay: vi.fn(async () => reply)
  }
}

const LOCAL = { target: { paneKey: 'tab-1:leaf-1' }, mode: 'beside', flash: true } as const

describe('showSession', () => {
  it('asks the window to show the row beside and reports where it went', async () => {
    const d = deps({ placement: 'split', keptKeyboardFocus: false })
    const result = await showSession(d, { ...LOCAL, drivesHostWindow: true })
    expect(d.relay).toHaveBeenCalledWith({
      kind: 'showSession',
      paneKey: 'tab-1:leaf-1',
      tabId: 'tab-1',
      mode: 'beside',
      flash: true
    })
    expect(result).toEqual({
      shown: true,
      mode: 'beside',
      placement: 'split',
      keptKeyboardFocus: false,
      target: { paneKey: 'tab-1:leaf-1', tabId: 'tab-1', title: 'Ads', worktreeId: 'wt-1' },
      summary: 'Showing “Ads” on the right, split beside the current view.'
    })
  })

  it('says so when the person kept typing', async () => {
    const d = deps({ placement: 'grid-replaced', keptKeyboardFocus: true })
    const result = await showSession(d, { ...LOCAL, drivesHostWindow: true })
    expect(result.summary).toBe(
      'The Grid was full: “Ads” took the place of its least recently used pane. Keyboard focus stayed where you were typing.'
    )
  })

  it('never reads or moves the host window for a remote caller', async () => {
    const d = deps({ placement: 'split', keptKeyboardFocus: false })
    const result = await showSession(d, { ...LOCAL, drivesHostWindow: false })
    expect(d.readRows).not.toHaveBeenCalled()
    expect(d.relay).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      shown: false,
      target: null,
      summary: SESSION_SHOW_REMOTE_SUMMARY
    })
  })

  it('reports an older window that does not know the request as not shown', async () => {
    const result = await showSession(deps(undefined), { ...LOCAL, drivesHostWindow: true })
    expect(result).toMatchObject({ shown: false, summary: SESSION_SHOW_OLD_WINDOW_SUMMARY })
  })

  it('refuses a pane the sidebar does not list', async () => {
    await expect(
      showSession(deps(null), {
        ...LOCAL,
        target: { paneKey: 'tab-9:leaf-9' },
        drivesHostWindow: true
      })
    ).rejects.toThrow('No conversation in the sidebar has pane tab-9:leaf-9')
  })
})

describe('callerDrivesHostWindow', () => {
  it('lets only the local, in-process CLI drive the window', () => {
    expect(callerDrivesHostWindow({})).toBe(true)
    expect(callerDrivesHostWindow({ clientKind: 'mobile' })).toBe(false)
    expect(callerDrivesHostWindow({ clientKind: 'runtime' })).toBe(false)
    expect(callerDrivesHostWindow({ pairedDeviceId: 'phone-1' })).toBe(false)
    expect(callerDrivesHostWindow({ clientId: 'device-token' })).toBe(false)
  })
})
