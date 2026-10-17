// @vitest-environment happy-dom
import { act, renderHook, cleanup } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useMinuteTick } from './conversation-retention'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('wakes snoozed rows at their deadline between minute ticks', () => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
  const wakeTimes = { first: 91_000, second: 101_000 }
  const { result } = renderHook(() => useMinuteTick(wakeTimes))
  act(() => vi.advanceTimersByTime(89_999))
  expect(result.current).toBeLessThan(91_000)
  act(() => vi.advanceTimersByTime(1))
  expect(result.current).toBe(91_000)
  act(() => vi.advanceTimersByTime(10_000))
  expect(result.current).toBe(101_000)
})
