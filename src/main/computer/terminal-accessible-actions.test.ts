import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComputerSnapshotResult } from '../../shared/runtime-types'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { actOnTerminalAccessibleRenderer } from './terminal-accessible-renderer'
import { callComputerSidecarAction, callComputerSidecarSnapshot } from './sidecar-client'
import {
  observeTerminalAccessibleSnapshot,
  performTerminalAccessibleAction,
  resetTerminalAccessibleSnapshots
} from './terminal-accessible-actions'

vi.mock('./terminal-accessible-renderer', () => ({ actOnTerminalAccessibleRenderer: vi.fn() }))
vi.mock('./sidecar-client', () => ({
  callComputerSidecarAction: vi.fn(),
  callComputerSidecarSnapshot: vi.fn()
}))
const paneKey = 'tab-b:22222222-2222-4222-8222-222222222222'
const target = { app: 'OmniConsole', elementIndex: 9, noScreenshot: true }
function snapshot(pid = process.pid): ComputerSnapshotResult {
  return {
    snapshot: {
      id: 'snapshot',
      app: { name: 'OmniConsole', bundleId: null, pid },
      window: { title: 'OmniConsole', width: 800, height: 600 },
      coordinateSpace: 'window',
      treeText: `9 text field (settable) Terminal input (omni-terminal=${encodeURIComponent(paneKey)})`,
      elementCount: 1,
      focusedElementId: null
    },
    screenshot: null,
    screenshotStatus: { state: 'skipped', reason: 'no_screenshot_flag' }
  }
}
function runtime() {
  return {
    resolveTerminalPane: vi.fn().mockReturnValue({ handle: 'terminal-b' }),
    focusTerminal: vi.fn().mockResolvedValue({ navigated: true }),
    sendTerminal: vi.fn().mockResolvedValue({ accepted: true })
  } as unknown as Pick<OrcaRuntimeService, 'resolveTerminalPane' | 'focusTerminal' | 'sendTerminal'>
}
beforeEach(() => {
  vi.clearAllMocks()
  resetTerminalAccessibleSnapshots()
  vi.mocked(callComputerSidecarSnapshot).mockResolvedValue(snapshot())
  vi.mocked(callComputerSidecarAction).mockResolvedValue(snapshot())
})
describe('accessible terminal actions', () => {
  it('focuses the observed pane without clicking the hidden textarea coordinates', async () => {
    const host = runtime()
    await observeTerminalAccessibleSnapshot(target, host)
    await performTerminalAccessibleAction('click', target, host)
    expect(host.resolveTerminalPane).toHaveBeenCalledWith(paneKey)
    expect(host.focusTerminal).toHaveBeenCalledWith('terminal-b', { navigateHost: true })
    expect(callComputerSidecarAction).not.toHaveBeenCalled()
    expect(host.sendTerminal).not.toHaveBeenCalled()
  })
  it.each(['literal text', 'line\n', 'a\r\nb', ''])(
    'writes %j with no implicit Enter',
    async (value) => {
      const host = runtime()
      await observeTerminalAccessibleSnapshot(target, host)
      await performTerminalAccessibleAction('setValue', { ...target, value }, host)
      expect(actOnTerminalAccessibleRenderer).toHaveBeenCalledWith(paneKey, value)
      expect(callComputerSidecarAction).not.toHaveBeenCalled()
    }
  )
  it('refuses replacement PTYs under the observed pane', async () => {
    const host = runtime()
    await observeTerminalAccessibleSnapshot(target, host)
    vi.mocked(host.resolveTerminalPane).mockReturnValue({ handle: 'replacement' } as ReturnType<
      typeof host.resolveTerminalPane
    >)
    await expect(
      performTerminalAccessibleAction('setValue', { ...target, value: 'x' }, host)
    ).rejects.toMatchObject({ code: 'element_not_found' })
    expect(host.focusTerminal).not.toHaveBeenCalled()
    expect(host.sendTerminal).not.toHaveBeenCalled()
    expect(callComputerSidecarAction).not.toHaveBeenCalled()
  })
  it('does not intercept another process with the same accessible label', async () => {
    vi.mocked(callComputerSidecarSnapshot).mockResolvedValue(snapshot(process.pid + 1))
    const host = runtime()
    await observeTerminalAccessibleSnapshot(target, host)
    await performTerminalAccessibleAction('click', target, host)
    expect(callComputerSidecarAction).toHaveBeenCalledWith('click', target)
    expect(host.focusTerminal).not.toHaveBeenCalled()
  })
  it('passes a snapshot-less action result through untouched', async () => {
    vi.mocked(callComputerSidecarAction).mockResolvedValue({
      action: { path: 'sidecar', actionName: 'click', verification: { state: 'unverified', reason: 'synthetic_input' } }
    } as unknown as Awaited<ReturnType<typeof callComputerSidecarAction>>)
    const host = runtime()
    const untargeted = { app: 'OmniConsole', noScreenshot: true }
    const result = await performTerminalAccessibleAction('click', untargeted, host)
    expect(result).toEqual({
      action: { path: 'sidecar', actionName: 'click', verification: { state: 'unverified', reason: 'synthetic_input' } }
    })
    expect(host.focusTerminal).not.toHaveBeenCalled()
    expect(actOnTerminalAccessibleRenderer).not.toHaveBeenCalled()
  })
  it('does not write when focus cannot reveal the target', async () => {
    const host = runtime()
    await observeTerminalAccessibleSnapshot(target, host)
    vi.mocked(host.focusTerminal).mockResolvedValue({ navigated: false } as Awaited<
      ReturnType<typeof host.focusTerminal>
    >)
    await expect(
      performTerminalAccessibleAction('setValue', { ...target, value: 'x' }, host)
    ).rejects.toMatchObject({ code: 'window_not_focused' })
    expect(host.sendTerminal).not.toHaveBeenCalled()
  })
})
