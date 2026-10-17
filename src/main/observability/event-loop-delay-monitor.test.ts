import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetTracerForTests, setActiveSink, type TracerSink } from './tracer'
import {
  EVENT_LOOP_DELAY_SPAN,
  startEventLoopDelayMonitor,
  type EventLoopDelayHistogram
} from './event-loop-delay-monitor'

type FakeHistogram = EventLoopDelayHistogram & {
  enabled: boolean
  resets: number
  values: { p50: number; p99: number; min: number; max: number; mean: number; count?: number }
}

const MS = 1_000_000

function createFakeHistogram(): FakeHistogram {
  const histogram: FakeHistogram = {
    enabled: false,
    resets: 0,
    values: { p50: 12 * MS, p99: 48.5 * MS, min: 10 * MS, max: 180 * MS, mean: 14 * MS, count: 3000 },
    enable() {
      histogram.enabled = true
    },
    disable() {
      histogram.enabled = false
    },
    reset() {
      histogram.resets += 1
    },
    percentile(percentile: number) {
      return percentile === 50 ? histogram.values.p50 : histogram.values.p99
    },
    get min() {
      return histogram.values.min
    },
    get max() {
      return histogram.values.max
    },
    get mean() {
      return histogram.values.mean
    },
    get count() {
      return histogram.values.count
    }
  }
  return histogram
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  _resetTracerForTests()
})

describe('event-loop delay monitor', () => {
  it('emits p50/p99/max once per minute and starts a fresh window', () => {
    const histogram = createFakeHistogram()
    const record = vi.fn()
    const monitor = startEventLoopDelayMonitor({
      createHistogram: () => histogram,
      isEnabled: () => true,
      record
    })
    expect(histogram.enabled).toBe(true)

    vi.advanceTimersByTime(59_999)
    expect(record).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(record).toHaveBeenCalledTimes(1)
    expect(record.mock.calls[0]![0]).toEqual({
      'event_loop.window_ms': 60_000,
      'event_loop.resolution_ms': 20,
      'event_loop.p50_ms': 12,
      'event_loop.p99_ms': 48.5,
      'event_loop.max_ms': 180,
      'event_loop.min_ms': 10,
      'event_loop.mean_ms': 14,
      'event_loop.samples': 3000
    })
    expect(histogram.resets).toBe(1)

    vi.advanceTimersByTime(60_000)
    expect(record).toHaveBeenCalledTimes(2)
    monitor.stop()
    expect(histogram.enabled).toBe(false)
    vi.advanceTimersByTime(180_000)
    expect(record).toHaveBeenCalledTimes(2)
  })

  it('skips a window that collected no samples', () => {
    const histogram = createFakeHistogram()
    histogram.values.count = 0
    const record = vi.fn()
    const monitor = startEventLoopDelayMonitor({
      createHistogram: () => histogram,
      isEnabled: () => true,
      record
    })
    vi.advanceTimersByTime(60_000)
    expect(record).not.toHaveBeenCalled()
    monitor.stop()
  })

  it('stops sampling and writing while the kill switch is off, and resumes after', () => {
    let enabled = false
    const created: FakeHistogram[] = []
    const record = vi.fn()
    const monitor = startEventLoopDelayMonitor({
      createHistogram: () => {
        const histogram = createFakeHistogram()
        created.push(histogram)
        return histogram
      },
      isEnabled: () => enabled,
      record
    })
    expect(created).toHaveLength(0)
    vi.advanceTimersByTime(120_000)
    expect(record).not.toHaveBeenCalled()

    enabled = true
    vi.advanceTimersByTime(60_000)
    // The first enabled tick opens a window; the next one reports it.
    expect(created).toHaveLength(1)
    expect(record).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60_000)
    expect(record).toHaveBeenCalledTimes(1)

    enabled = false
    vi.advanceTimersByTime(60_000)
    expect(created[0]!.enabled).toBe(false)
    expect(record).toHaveBeenCalledTimes(1)
    monitor.stop()
  })

  it('never throws from the timer when the histogram fails', () => {
    const record = vi.fn()
    const monitor = startEventLoopDelayMonitor({
      createHistogram: () => {
        throw new Error('perf_hooks unavailable')
      },
      isEnabled: () => true,
      record
    })
    expect(() => vi.advanceTimersByTime(180_000)).not.toThrow()
    expect(record).not.toHaveBeenCalled()
    monitor.stop()
  })

  it('writes a perf span into the trace sink by default', () => {
    const records: Record<string, unknown>[] = []
    const sink: TracerSink = {
      push(record) {
        records.push(record as Record<string, unknown>)
      },
      flush() {
        /* no-op */
      },
      close() {
        /* no-op */
      }
    }
    setActiveSink(sink)
    const histogram = createFakeHistogram()
    const monitor = startEventLoopDelayMonitor({
      createHistogram: () => histogram,
      isEnabled: () => true
    })
    vi.advanceTimersByTime(60_000)
    monitor.stop()

    expect(records).toHaveLength(1)
    expect(records[0]!.name).toBe(EVENT_LOOP_DELAY_SPAN)
    const attributes = records[0]!.attributes as Record<string, unknown>
    expect(attributes.kind).toBe('perf')
    expect(attributes['event_loop.p99_ms']).toBe(48.5)
  })
})
