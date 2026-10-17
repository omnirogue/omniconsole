import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_EVENT_TIMESTAMP_AGE_MS,
  createTerminalInputLatencySampler,
  resolveKeydownStart,
  summarizeTerminalInputLatency,
  type LatencyTerminal,
  type TerminalInputLatencySampler,
  type TerminalInputLatencySummary
} from './terminal-input-latency'

type FakeTerminal = LatencyTerminal & {
  render: () => void
  parse: () => void
  listenerCount: () => number
}

function createFakeTerminal(options: { withWriteParsed?: boolean } = {}): FakeTerminal {
  const renderListeners = new Set<() => void>()
  const parseListeners = new Set<() => void>()
  const terminal: FakeTerminal = {
    onRender(listener) {
      renderListeners.add(listener)
      return { dispose: () => renderListeners.delete(listener) }
    },
    render: () => {
      for (const listener of Array.from(renderListeners)) {
        listener()
      }
    },
    parse: () => {
      for (const listener of Array.from(parseListeners)) {
        listener()
      }
    },
    listenerCount: () => renderListeners.size + parseListeners.size
  }
  if (options.withWriteParsed !== false) {
    terminal.onWriteParsed = (listener) => {
      parseListeners.add(listener)
      return { dispose: () => parseListeners.delete(listener) }
    }
  }
  return terminal
}

let records: TerminalInputLatencySummary[]
let enabled: boolean
let sampler: TerminalInputLatencySampler

function createSampler(options: { frameMs?: number } = {}): TerminalInputLatencySampler {
  return createTerminalInputLatencySampler({
    now: () => Date.now(),
    isEnabled: () => enabled,
    record: (summary) => records.push(summary),
    setInterval: (callback, ms) => setInterval(callback, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    ...(options.frameMs !== undefined
      ? { requestFrame: (callback: () => void) => void setTimeout(callback, options.frameMs) }
      : {})
  })
}

/** One keystroke: keydown, xterm input, echo after `echoMs`, parse, paint after `paintMs`. */
function typeKey(
  terminal: FakeTerminal,
  timing: { echoMs: number; paintMs: number },
  paneKey = 'tab-1:pane-1'
): void {
  sampler.noteKeydown(paneKey, Date.now())
  sampler.noteTerminalInput(paneKey, terminal)
  vi.advanceTimersByTime(timing.echoMs)
  sampler.noteOutput(paneKey)
  terminal.parse()
  vi.advanceTimersByTime(timing.paintMs - timing.echoMs)
  terminal.render()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-30T12:00:00Z'))
  records = []
  enabled = true
  sampler = createSampler()
})

afterEach(() => {
  sampler.dispose()
  vi.useRealTimers()
})

describe('summarizeTerminalInputLatency (percentile math)', () => {
  it('reports nearest-rank p50/p95 and max', () => {
    const summary = summarizeTerminalInputLatency({
      windowMs: 60_000,
      keys: 20,
      echoMs: Array.from({ length: 20 }, (_, index) => index + 1),
      paintMs: [40, 10, 30, 20],
      unechoed: 0,
      unpainted: 0
    })
    expect(summary).toEqual({
      windowMs: 60_000,
      keys: 20,
      echoCount: 20,
      echoP50Ms: 10,
      echoP95Ms: 19,
      echoMaxMs: 20,
      paintCount: 4,
      paintP50Ms: 20,
      paintP95Ms: 40,
      paintMaxMs: 40,
      unechoed: 0,
      unpainted: 0
    })
  })

  it('handles a single sample and omits percentiles with no samples', () => {
    expect(
      summarizeTerminalInputLatency({
        windowMs: 60_000.4,
        keys: 3,
        echoMs: [12.345],
        paintMs: [],
        unechoed: 2,
        unpainted: 1
      })
    ).toEqual({
      windowMs: 60_000,
      keys: 3,
      echoCount: 1,
      echoP50Ms: 12.35,
      echoP95Ms: 12.35,
      echoMaxMs: 12.35,
      paintCount: 0,
      unechoed: 2,
      unpainted: 1
    })
  })
})

describe('resolveKeydownStart', () => {
  it('starts at the OS keystroke time however late the handler ran', () => {
    expect(resolveKeydownStart(1_000, 1_040)).toBe(1_000)
    expect(resolveKeydownStart(1_000, 1_900)).toBe(1_000)
    expect(resolveKeydownStart(1_000, 2_500)).toBe(1_000)
  })

  it('clamps an ancient timestamp to a lower bound instead of re-basing it', () => {
    const handledAt = 10 * 60_000
    expect(resolveKeydownStart(1, handledAt)).toBe(handledAt - MAX_EVENT_TIMESTAMP_AGE_MS)
  })

  it('uses the handler time only when the event has no usable OS time', () => {
    expect(resolveKeydownStart(undefined, 500)).toBe(500)
    expect(resolveKeydownStart(Number.NaN, 500)).toBe(500)
    expect(resolveKeydownStart(0, 500)).toBe(500)
    // Another clock (an epoch timestamp against performance.now()).
    expect(resolveKeydownStart(1_790_000_000_000, 500)).toBe(500)
    // Coarsened clocks: a hair in the future is the handler time, not another clock.
    expect(resolveKeydownStart(501, 500)).toBe(500)
  })
})

describe('terminal input latency sampler', () => {
  it('emits one summary per active minute with echo and paint percentiles', () => {
    const terminal = createFakeTerminal()
    typeKey(terminal, { echoMs: 20, paintMs: 35 })
    vi.advanceTimersByTime(1_000)
    typeKey(terminal, { echoMs: 60, paintMs: 90 })
    vi.advanceTimersByTime(1_000)
    typeKey(terminal, { echoMs: 40, paintMs: 45 })

    expect(records).toHaveLength(0)
    vi.advanceTimersByTime(60_000)
    expect(records).toHaveLength(1)
    expect(records[0]).toEqual({
      windowMs: 60_000,
      keys: 3,
      echoCount: 3,
      echoP50Ms: 40,
      echoP95Ms: 60,
      echoMaxMs: 60,
      paintCount: 3,
      paintP50Ms: 45,
      paintP95Ms: 90,
      paintMaxMs: 90,
      unechoed: 0,
      unpainted: 0
    })
    // The render listeners live only while a keystroke is in flight.
    expect(terminal.listenerCount()).toBe(0)
  })

  it('writes nothing for a minute without keystrokes and stops its timer', () => {
    const terminal = createFakeTerminal()
    typeKey(terminal, { echoMs: 10, paintMs: 20 })
    vi.advanceTimersByTime(60_000)
    expect(records).toHaveLength(1)

    vi.advanceTimersByTime(60_000)
    expect(records).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)

    vi.advanceTimersByTime(10 * 60_000)
    expect(records).toHaveLength(1)
  })

  it('never starts without a keystroke: output and programmatic input alone record nothing', () => {
    const terminal = createFakeTerminal()
    sampler.noteOutput('tab-1:pane-1')
    sampler.noteTerminalInput('tab-1:pane-1', terminal)
    sampler.noteOutput('tab-1:pane-1')
    terminal.render()
    vi.advanceTimersByTime(5 * 60_000)
    expect(records).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores a keydown whose input never followed, or went to another pane', () => {
    const terminal = createFakeTerminal()
    sampler.noteKeydown('tab-1:pane-1', Date.now())
    vi.advanceTimersByTime(150)
    sampler.noteTerminalInput('tab-1:pane-1', terminal)
    sampler.noteKeydown('tab-1:pane-1', Date.now())
    sampler.noteTerminalInput('tab-2:pane-1', terminal)
    vi.advanceTimersByTime(60_000)
    expect(records).toHaveLength(0)
  })

  it('counts a keystroke with no echo inside 500 ms as unechoed', () => {
    const terminal = createFakeTerminal()
    sampler.noteKeydown('tab-1:pane-1', Date.now())
    sampler.noteTerminalInput('tab-1:pane-1', terminal)
    vi.advanceTimersByTime(600)
    sampler.noteOutput('tab-1:pane-1')
    vi.advanceTimersByTime(60_000)
    expect(records[0]).toMatchObject({
      keys: 1,
      echoCount: 0,
      paintCount: 0,
      unechoed: 1,
      unpainted: 0
    })
    expect(terminal.listenerCount()).toBe(0)
  })

  it('counts an echoed keystroke whose paint never lands as unpainted', () => {
    const terminal = createFakeTerminal()
    sampler.noteKeydown('tab-1:pane-1', Date.now())
    sampler.noteTerminalInput('tab-1:pane-1', terminal)
    vi.advanceTimersByTime(50)
    sampler.noteOutput('tab-1:pane-1')
    terminal.parse()
    // The GPU/compositor stalls: no render before the sample's expiry.
    vi.advanceTimersByTime(2_000)
    terminal.render()
    vi.advanceTimersByTime(60_000)
    expect(records[0]).toMatchObject({
      keys: 1,
      echoCount: 1,
      echoMaxMs: 50,
      paintCount: 0,
      unechoed: 0,
      unpainted: 1
    })
    expect(terminal.listenerCount()).toBe(0)
  })

  it('counts a paint that lands after the paint window as unpainted, not as nothing', () => {
    sampler.dispose()
    sampler = createSampler({ frameMs: 16 })
    const terminal = createFakeTerminal()
    sampler.noteKeydown('tab-1:pane-1', Date.now())
    sampler.noteTerminalInput('tab-1:pane-1', terminal)
    vi.advanceTimersByTime(50)
    sampler.noteOutput('tab-1:pane-1')
    terminal.parse()
    vi.advanceTimersByTime(1_100)
    terminal.render()
    vi.advanceTimersByTime(60_000)
    expect(records[0]).toMatchObject({ echoCount: 1, paintCount: 0, unpainted: 1 })
  })

  it('counts an unpainted sample the next keystroke replaces', () => {
    const terminal = createFakeTerminal()
    sampler.noteKeydown('tab-1:pane-1', Date.now())
    sampler.noteTerminalInput('tab-1:pane-1', terminal)
    vi.advanceTimersByTime(20)
    sampler.noteOutput('tab-1:pane-1')
    terminal.parse()
    vi.advanceTimersByTime(1_200)
    typeKey(terminal, { echoMs: 10, paintMs: 15 })
    vi.advanceTimersByTime(60_000)
    expect(records[0]).toMatchObject({
      keys: 2,
      echoCount: 2,
      paintCount: 1,
      paintMaxMs: 15,
      unpainted: 1
    })
  })

  it('measures the first key of a burst and counts the rest', () => {
    const terminal = createFakeTerminal()
    sampler.noteKeydown('tab-1:pane-1', Date.now())
    sampler.noteTerminalInput('tab-1:pane-1', terminal)
    vi.advanceTimersByTime(30)
    sampler.noteKeydown('tab-1:pane-1', Date.now())
    sampler.noteTerminalInput('tab-1:pane-1', terminal)
    vi.advanceTimersByTime(50)
    sampler.noteOutput('tab-1:pane-1')
    terminal.parse()
    terminal.render()
    vi.advanceTimersByTime(60_000)
    expect(records[0]).toMatchObject({ keys: 2, echoCount: 1, echoMaxMs: 80, paintCount: 1 })
  })

  it('times paint from the render after the echo is parsed, not an earlier queued render', () => {
    const terminal = createFakeTerminal()
    sampler.noteKeydown('tab-1:pane-1', Date.now())
    sampler.noteTerminalInput('tab-1:pane-1', terminal)
    vi.advanceTimersByTime(10)
    sampler.noteOutput('tab-1:pane-1')
    vi.advanceTimersByTime(5)
    terminal.render() // queued before the echo parsed — not the echo's paint
    vi.advanceTimersByTime(20)
    terminal.parse()
    vi.advanceTimersByTime(15)
    terminal.render()
    vi.advanceTimersByTime(60_000)
    expect(records[0]).toMatchObject({ echoMaxMs: 10, paintCount: 1, paintMaxMs: 50 })
  })

  it('times paint at the next animation frame after the render, once', () => {
    sampler.dispose()
    sampler = createSampler({ frameMs: 16 })
    const terminal = createFakeTerminal()
    sampler.noteKeydown('tab-1:pane-1', Date.now())
    sampler.noteTerminalInput('tab-1:pane-1', terminal)
    vi.advanceTimersByTime(10)
    sampler.noteOutput('tab-1:pane-1')
    terminal.parse()
    vi.advanceTimersByTime(4)
    terminal.render()
    vi.advanceTimersByTime(5)
    terminal.render() // a second render before the frame must not record twice
    vi.advanceTimersByTime(60_000)
    expect(records[0]).toMatchObject({ echoMaxMs: 10, paintCount: 1, paintMaxMs: 30 })
  })

  it('falls back to the first render after the echo when xterm has no parse event', () => {
    const terminal = createFakeTerminal({ withWriteParsed: false })
    typeKey(terminal, { echoMs: 12, paintMs: 30 })
    vi.advanceTimersByTime(60_000)
    expect(records[0]).toMatchObject({ echoCount: 1, paintCount: 1, paintMaxMs: 30 })
  })

  it('starts the clock at the OS keystroke time so renderer input delay is included', () => {
    const terminal = createFakeTerminal()
    sampler.noteKeydown('tab-1:pane-1', Date.now() - 40)
    sampler.noteTerminalInput('tab-1:pane-1', terminal)
    vi.advanceTimersByTime(10)
    sampler.noteOutput('tab-1:pane-1')
    vi.advanceTimersByTime(60_000)
    expect(records[0]).toMatchObject({ echoMaxMs: 50 })
  })

  it('samples a keystroke whose renderer dispatch ran 400 ms late and reports the stall', () => {
    const terminal = createFakeTerminal()
    // The renderer was blocked: the OS stamped the key 400 ms before the handler ran,
    // then keydown and xterm input ran back to back.
    sampler.noteKeydown('tab-1:pane-1', Date.now() - 400)
    sampler.noteTerminalInput('tab-1:pane-1', terminal)
    vi.advanceTimersByTime(10)
    sampler.noteOutput('tab-1:pane-1')
    terminal.parse()
    vi.advanceTimersByTime(5)
    terminal.render()
    vi.advanceTimersByTime(60_000)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      keys: 1,
      echoCount: 1,
      echoMaxMs: 410,
      paintCount: 1,
      paintMaxMs: 415,
      unechoed: 0
    })
  })

  it('keeps a stall longer than the echo window in the echo measure', () => {
    const terminal = createFakeTerminal()
    sampler.noteKeydown('tab-1:pane-1', Date.now() - 900)
    sampler.noteTerminalInput('tab-1:pane-1', terminal)
    vi.advanceTimersByTime(10)
    sampler.noteOutput('tab-1:pane-1')
    vi.advanceTimersByTime(60_000)
    expect(records[0]).toMatchObject({ keys: 1, echoCount: 1, echoMaxMs: 910, unechoed: 0 })
  })

  it('does not re-base a keystroke that waited more than a second', () => {
    const terminal = createFakeTerminal()
    sampler.noteKeydown('tab-1:pane-1', Date.now() - 1_500)
    sampler.noteTerminalInput('tab-1:pane-1', terminal)
    vi.advanceTimersByTime(10)
    sampler.noteOutput('tab-1:pane-1')
    vi.advanceTimersByTime(60_000)
    expect(records[0]).toMatchObject({ keys: 1, echoCount: 1, echoMaxMs: 1_510 })
  })

  it('reports stalled and fast keystrokes together in one minute', () => {
    const terminal = createFakeTerminal()
    typeKey(terminal, { echoMs: 10, paintMs: 20 })
    vi.advanceTimersByTime(1_000)
    sampler.noteKeydown('tab-1:pane-1', Date.now() - 300)
    sampler.noteTerminalInput('tab-1:pane-1', terminal)
    vi.advanceTimersByTime(10)
    sampler.noteOutput('tab-1:pane-1')
    terminal.parse()
    vi.advanceTimersByTime(10)
    terminal.render()
    vi.advanceTimersByTime(60_000)
    expect(records[0]).toMatchObject({
      keys: 2,
      echoCount: 2,
      echoMaxMs: 310,
      paintCount: 2,
      paintMaxMs: 320
    })
  })

  it('still pairs a keydown with its input on the handler clock', () => {
    const terminal = createFakeTerminal()
    // An old OS timestamp does not stretch the pairing window: input 150 ms after the
    // handler ran is not this keystroke's.
    sampler.noteKeydown('tab-1:pane-1', Date.now() - 50)
    vi.advanceTimersByTime(150)
    sampler.noteTerminalInput('tab-1:pane-1', terminal)
    sampler.noteOutput('tab-1:pane-1')
    vi.advanceTimersByTime(60_000)
    expect(records).toHaveLength(0)
  })

  it('records nothing and keeps no timers while the kill switch is off', () => {
    enabled = false
    const terminal = createFakeTerminal()
    typeKey(terminal, { echoMs: 10, paintMs: 20 })
    vi.advanceTimersByTime(5 * 60_000)
    expect(records).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('drops a sample cleanly when the terminal has no render event', () => {
    const broken = {
      onRender: () => {
        throw new Error('disposed terminal')
      }
    } as unknown as LatencyTerminal
    sampler.noteKeydown('tab-1:pane-1', Date.now())
    expect(() => sampler.noteTerminalInput('tab-1:pane-1', broken)).not.toThrow()
    sampler.noteOutput('tab-1:pane-1')
    vi.advanceTimersByTime(60_000)
    expect(records[0]).toMatchObject({ keys: 1, echoCount: 0, paintCount: 0 })
  })

  it('carries counts and durations only', () => {
    const terminal = createFakeTerminal()
    typeKey(terminal, { echoMs: 10, paintMs: 20 }, 'tab-secret:pane-9')
    vi.advanceTimersByTime(60_000)
    expect(records).toHaveLength(1)
    for (const value of Object.values(records[0]!)) {
      expect(typeof value).toBe('number')
    }
    expect(JSON.stringify(records)).not.toContain('secret')
  })
})
