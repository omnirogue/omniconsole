import { describe, expect, it, vi } from 'vitest'
import type { AutomationRun } from '../../shared/automations-types'
import { shouldCloseFailedAutomationPane } from '../../shared/automation-failed-pane'
import {
  closeOwnedAutomationRunTerminal,
  createFailedAutomationPaneCleanup
} from './failed-pane-cleanup'

const failedRun = (overrides: Partial<AutomationRun> = {}): AutomationRun =>
  ({
    id: 'run',
    automationId: 'automation',
    status: 'dispatch_failed',
    error: 'Automation agent is blocked: Hooks need review.',
    ownsTerminal: true,
    terminalPaneKey: 'tab:leaf',
    terminalPtyId: 'pty',
    ...overrides
  }) as AutomationRun

describe('failed automation pane cleanup', () => {
  it.each([
    [{}, true],
    [{ error: 'Automation agent never started after the prompt was submitted.' }, true],
    [{ ownsTerminal: false }, false],
    [{ ownsTerminal: undefined }, false],
    [{ terminalPaneKey: null }, false],
    [{ terminalPtyId: null }, false],
    [{ status: 'completed' }, false],
    [{ error: 'Transport unavailable' }, false],
    [
      { error: 'OmniConsole stopped watching this run after 6h without a completion signal.' },
      false
    ]
  ] as const)('only closes positively owned startup failures: %j', (patch, expected) => {
    expect(shouldCloseFailedAutomationPane(failedRun(patch))).toBe(expected)
  })

  it('injects cleanup and never closes reused panes', async () => {
    const close = vi.fn().mockResolvedValue(undefined)
    const cleanup = createFailedAutomationPaneCleanup(close)
    await cleanup(failedRun({ ownsTerminal: false }))
    expect(close).not.toHaveBeenCalled()
    await cleanup(failedRun())
    expect(close).toHaveBeenCalledExactlyOnceWith(failedRun())
  })

  it('uses the runtime close path only while the exact PTY is current', async () => {
    const runtime = {
      getTerminalHandleForPaneKey: vi.fn(() => 'handle'),
      showTerminal: vi.fn().mockResolvedValue({ ptyId: 'pty' }),
      closeTerminal: vi.fn().mockResolvedValue({})
    }
    await closeOwnedAutomationRunTerminal(runtime, failedRun())
    expect(runtime.closeTerminal).toHaveBeenCalledExactlyOnceWith('handle')
    runtime.closeTerminal.mockClear()
    runtime.showTerminal.mockResolvedValue({ ptyId: 'replacement' })
    await closeOwnedAutomationRunTerminal(runtime, failedRun())
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    runtime.showTerminal.mockResolvedValue({ ptyId: 'pty' })
    runtime.getTerminalHandleForPaneKey
      .mockReturnValueOnce('handle')
      .mockReturnValueOnce('replacement-handle')
    await closeOwnedAutomationRunTerminal(runtime, failedRun())
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('coalesces concurrent closes and keeps close failures from rewriting the saved outcome', async () => {
    let release!: () => void
    const close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const cleanup = createFailedAutomationPaneCleanup(close)
    const first = cleanup(failedRun())
    const second = cleanup(failedRun())
    await Promise.resolve()
    release()
    await Promise.all([first, second])
    expect(close).toHaveBeenCalledTimes(1)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failing = createFailedAutomationPaneCleanup(async () => {
      throw new Error('unverifiable')
    })
    await expect(failing(failedRun())).resolves.toBeUndefined()
    expect(log).toHaveBeenCalled()
    log.mockRestore()
  })
})
