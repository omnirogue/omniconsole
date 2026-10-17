import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { recordBreadcrumbMock, storeState } = vi.hoisted(() => ({
  recordBreadcrumbMock: vi.fn(),
  storeState: { settings: { latencyTelemetry: true } as { latencyTelemetry?: boolean } | null }
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => storeState }
}))

vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: (...args: unknown[]) => recordBreadcrumbMock(...args)
}))

import {
  noteTerminalInputForLatency,
  noteTerminalKeydownForLatency,
  noteTerminalOutputForLatency,
  toTerminalInputLatencyBreadcrumbData
} from './terminal-input-latency-probe'
import type { TerminalInputLatencySummary } from './terminal-input-latency'

function createTerminal(): {
  onRender: (listener: () => void) => { dispose: () => void }
  onWriteParsed: (listener: () => void) => { dispose: () => void }
  emitParsed: () => void
  emitRender: () => void
} {
  const render = new Set<() => void>()
  const parsed = new Set<() => void>()
  return {
    onRender: (listener) => {
      render.add(listener)
      return { dispose: () => render.delete(listener) }
    },
    onWriteParsed: (listener) => {
      parsed.add(listener)
      return { dispose: () => parsed.delete(listener) }
    },
    emitParsed: () => {
      for (const listener of Array.from(parsed)) {
        listener()
      }
    },
    emitRender: () => {
      for (const listener of Array.from(render)) {
        listener()
      }
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance']
  })
  recordBreadcrumbMock.mockReset()
  storeState.settings = { latencyTelemetry: true }
})

afterEach(() => {
  // Drain the shared sampler's open window so tests stay independent.
  vi.advanceTimersByTime(3 * 60_000)
  vi.useRealTimers()
})

describe('terminal input latency probe', () => {
  it('reports timing only: no key, code or typed text reaches the breadcrumb', () => {
    const terminal = createTerminal()
    const keystroke = {
      timeStamp: performance.now(),
      key: 'p',
      code: 'KeyP',
      data: 'my-password-typed-here'
    } as unknown as KeyboardEvent
    noteTerminalKeydownForLatency('tab-1:pane-1', keystroke)
    noteTerminalInputForLatency('tab-1:pane-1', terminal)
    vi.advanceTimersByTime(25)
    noteTerminalOutputForLatency('tab-1:pane-1')
    terminal.emitParsed()
    vi.advanceTimersByTime(10)
    terminal.emitRender()
    vi.advanceTimersByTime(60_000)

    expect(recordBreadcrumbMock).toHaveBeenCalledTimes(1)
    const [name, data] = recordBreadcrumbMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(name).toBe('terminal_input_latency')
    expect(Object.keys(data).sort()).toEqual(
      [
        'echoCount',
        'echoMaxMs',
        'echoP50Ms',
        'echoP95Ms',
        'keys',
        'paintCount',
        'paintMaxMs',
        'paintP50Ms',
        'paintP95Ms',
        'unechoed',
        'unpainted',
        'windowMs'
      ].sort()
    )
    for (const value of Object.values(data)) {
      expect(typeof value).toBe('number')
    }
    const serialized = JSON.stringify(recordBreadcrumbMock.mock.calls)
    expect(serialized).not.toContain('KeyP')
    expect(serialized).not.toContain('password')
    expect(serialized).not.toContain('tab-1')
    expect(data.echoMaxMs).toBe(25)
    expect(data.paintMaxMs).toBe(35)
  })

  it('measures from the OS keystroke time when the renderer handled the key late', () => {
    const terminal = createTerminal()
    // Why advance first: the faked performance clock starts at 0 for each test.
    vi.advanceTimersByTime(1_000)
    noteTerminalKeydownForLatency('tab-1:pane-1', { timeStamp: performance.now() - 300 })
    noteTerminalInputForLatency('tab-1:pane-1', terminal)
    vi.advanceTimersByTime(20)
    noteTerminalOutputForLatency('tab-1:pane-1')
    vi.advanceTimersByTime(60_000)

    expect(recordBreadcrumbMock).toHaveBeenCalledTimes(1)
    const [, data] = recordBreadcrumbMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(data).toMatchObject({ keys: 1, echoCount: 1, echoMaxMs: 320 })
  })

  it('writes nothing while the latencyTelemetry setting is off', () => {
    storeState.settings = { latencyTelemetry: false }
    const terminal = createTerminal()
    noteTerminalKeydownForLatency('tab-1:pane-1', { timeStamp: performance.now() })
    noteTerminalInputForLatency('tab-1:pane-1', terminal)
    noteTerminalOutputForLatency('tab-1:pane-1')
    vi.advanceTimersByTime(2 * 60_000)
    expect(recordBreadcrumbMock).not.toHaveBeenCalled()
  })

  it('keeps only finite numbers when converting a summary to breadcrumb data', () => {
    const summary = {
      windowMs: 60_000,
      keys: 2,
      echoCount: 1,
      echoP50Ms: 12,
      paintCount: 0,
      unechoed: 1,
      smuggled: 'ls -la ~/secrets',
      notANumber: Number.NaN
    } as unknown as TerminalInputLatencySummary
    expect(toTerminalInputLatencyBreadcrumbData(summary)).toEqual({
      windowMs: 60_000,
      keys: 2,
      echoCount: 1,
      echoP50Ms: 12,
      paintCount: 0,
      unechoed: 1
    })
  })
})
