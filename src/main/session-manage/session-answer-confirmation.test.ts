import { afterEach, expect, it, vi } from 'vitest'
import { confirmSessionPromptExit, type PromptExitReading } from './session-answer-confirmation'

afterEach(() => vi.useRealTimers())

it('bounds an unreadable or hung post-write check without claiming success', async () => {
  vi.useFakeTimers()
  const check = vi.fn(() => new Promise<PromptExitReading>(() => {}))
  const result = confirmSessionPromptExit(check)
  await vi.advanceTimersByTimeAsync(2000)
  expect(await result).toEqual({
    status: 'unconfirmed',
    reason: 'a reading after the key did not finish in time'
  })
  expect(check).toHaveBeenCalledOnce()
})

it('treats a read failure after writing as an unconfirmed attempt, with its reason', async () => {
  vi.useFakeTimers()
  const result = confirmSessionPromptExit(async () => {
    throw new Error('Host disconnected')
  })
  await vi.advanceTimersByTimeAsync(250)
  expect(await result).toEqual({
    status: 'unconfirmed',
    reason: 'a reading after the key failed: Host disconnected'
  })
})

it('requires positive evidence that the prompt closed, twice, at least 300 ms apart', async () => {
  vi.useFakeTimers()
  const check = vi
    .fn(async (): Promise<PromptExitReading> => ({ kind: 'left' }))
    .mockResolvedValueOnce({ kind: 'waiting' })
  let settled = false
  const result = confirmSessionPromptExit(check).finally(() => {
    settled = true
  })
  // 250 ms waiting, 500 ms left, 750 ms left (only 250 ms after the first): not yet.
  await vi.advanceTimersByTimeAsync(750)
  expect(settled).toBe(false)
  // 1000 ms left, 500 ms after the first left: confirmed.
  await vi.advanceTimersByTimeAsync(250)
  expect(await result).toEqual({ status: 'confirmed' })
  expect(check).toHaveBeenCalledTimes(4)
})

// MINOR-R2-1: one reading without the prompt could have caught a redraw.
it.each([
  ['a single left reading', ['waiting', 'left', 'waiting']],
  [
    'left readings broken by a waiting one',
    ['left', 'waiting', 'left', 'waiting', 'left', 'waiting']
  ],
  [
    'left readings broken by an unreadable one',
    ['left', 'unreadable', 'left', 'unreadable', 'left', 'unreadable']
  ]
] as const)('never confirms on %s', async (_name, kinds) => {
  vi.useFakeTimers()
  const readings: PromptExitReading[] = kinds.map((kind) =>
    kind === 'unreadable' ? { kind, reason: 'its screen was empty' } : { kind }
  )
  let index = 0
  const check = vi.fn(async () => readings[Math.min(index++, readings.length - 1)]!)
  const result = confirmSessionPromptExit(check)
  await vi.advanceTimersByTimeAsync(2000)
  expect(await result).toMatchObject({ status: 'unconfirmed' })
})

// MAJOR-5: a screen that cannot be read or parsed is never taken for the prompt having closed.
it('never confirms on unreadable readings, and reports the last reason', async () => {
  vi.useFakeTimers()
  const check = vi.fn(async (): Promise<PromptExitReading> => ({
    kind: 'unreadable',
    reason: 'its screen could not be read'
  }))
  const result = confirmSessionPromptExit(check)
  await vi.advanceTimersByTimeAsync(2000)
  expect(await result).toEqual({ status: 'unconfirmed', reason: 'its screen could not be read' })
  expect(check.mock.calls.length).toBeGreaterThan(1)
})

it('says the prompt was still showing when it never left', async () => {
  vi.useFakeTimers()
  const result = confirmSessionPromptExit(async () => ({ kind: 'waiting' }))
  await vi.advanceTimersByTimeAsync(2000)
  expect(await result).toEqual({ status: 'unconfirmed', reason: 'the prompt was still showing' })
})
