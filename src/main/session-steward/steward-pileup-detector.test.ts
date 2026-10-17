import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  setStewardCleanupStarter,
  STEWARD_DETECTOR_RETRY_MS,
  STEWARD_STALLED_URGENT_MS,
  StewardPileupDetector,
  stewardPileupReason,
  type StewardLeftover
} from './steward-pileup-detector'
import { configureStewardSwitches } from './steward-switches'

const HOUR = 3_600_000
const cleanups: (() => void)[] = []
const settings: Record<string, unknown> = {}

beforeEach(() => {
  for (const key of Object.keys(settings)) {
    delete settings[key]
  }
  cleanups.push(configureStewardSwitches({ readSettings: () => settings, environment: {} }))
})
afterEach(() => {
  while (cleanups.length) {
    cleanups.pop()!()
  }
})

const leftover = (n: number, extra: Partial<StewardLeftover> = {}): StewardLeftover => ({
  paneKey: `p${n}`,
  title: `Session ${n}`,
  kind: 'finished-held',
  reason: 'JEV is unsure',
  since: 0,
  ...extra
})

describe('the pile-up count', () => {
  it('calls for a cleanup at the threshold, or for anything Stalled over a day', () => {
    const seven = Array.from({ length: 7 }, (_, n) => leftover(n))
    expect(stewardPileupReason(seven, 8, 10 * HOUR)).toBeNull()
    expect(stewardPileupReason([...seven, leftover(7)], 8, 10 * HOUR)).toBe(
      '8 sessions the rules could not settle (threshold 8)'
    )
    const stalled = leftover(9, { kind: 'stalled', since: 0 })
    expect(stewardPileupReason([stalled], 8, STEWARD_STALLED_URGENT_MS - 1)).toBeNull()
    expect(stewardPileupReason([stalled], 8, STEWARD_STALLED_URGENT_MS)).toBe(
      '“Session 9” has been Stalled for more than a day'
    )
  })

  it('asks WP-S4 for one automatic run, retries no sooner than 30 min, and records the outcome', async () => {
    const starter = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: 'skipped: capacity (codex)' })
      .mockResolvedValueOnce({ ok: true, runId: 'run-1' })
    cleanups.push(setStewardCleanupStarter(starter))
    const clock = { now: 0 }
    const note = vi.fn()
    const detector = new StewardPileupDetector({ now: () => clock.now, threshold: () => 2, note })
    const pile = [leftover(1), leftover(2)]
    await detector.run(pile)
    await detector.run(pile)
    expect(starter).toHaveBeenCalledTimes(1)
    expect(starter).toHaveBeenCalledWith({ source: 'automatic', leftovers: pile })
    expect(note).toHaveBeenLastCalledWith(
      'No cleanup session started (skipped: capacity (codex)): 2 sessions the rules could not settle (threshold 2).'
    )
    clock.now += STEWARD_DETECTOR_RETRY_MS
    await detector.run(pile)
    expect(starter).toHaveBeenCalledTimes(2)
    expect(note).toHaveBeenLastCalledWith(
      'Started a cleanup session: 2 sessions the rules could not settle (threshold 2).'
    )
  })

  it('asks nothing until the window has listed its sessions (an early run spends a daily one)', async () => {
    const starter = vi.fn(async () => ({ ok: true as const }))
    cleanups.push(setStewardCleanupStarter(starter))
    let ready = false
    const detector = new StewardPileupDetector({
      now: () => 0,
      threshold: () => 1,
      ready: () => ready,
      note: vi.fn()
    })
    await detector.run([leftover(1)])
    expect(starter).not.toHaveBeenCalled()
    ready = true
    await detector.run([leftover(1)])
    expect(starter).toHaveBeenCalledTimes(1)
  })

  it('only counts while automatic cleanup is off or no run is registered', async () => {
    const note = vi.fn()
    const detector = new StewardPileupDetector({ now: () => 0, threshold: () => 1, note })
    await detector.run([leftover(1)])
    const starter = vi.fn(async () => ({ ok: true as const }))
    cleanups.push(setStewardCleanupStarter(starter))
    settings.automaticCleanup = false
    await detector.run([leftover(1)])
    expect(starter).not.toHaveBeenCalled()
    expect(note).not.toHaveBeenCalled()
  })
})
