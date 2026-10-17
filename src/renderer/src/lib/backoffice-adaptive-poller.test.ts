// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installBackofficeAdaptivePoller } from './backoffice-adaptive-poller'
import { subscribeWorkRefresh } from '@/components/task-page/backoffice/backoffice-work-refresh'
import { BACKOFFICE_POLLING as cadence } from '../../../shared/backoffice-polling-cadence'

let visible = true
let stops: (() => void)[]
vi.mock('./window-park-visibility', () => ({
  getWindowParkVisible: () => visible,
  subscribeWindowParkVisibility: (run: () => void) => {
    document.addEventListener('visibilitychange', run)
    return () => document.removeEventListener('visibilitychange', run)
  }
}))
beforeEach(() => {
  vi.useFakeTimers()
  visible = true
  stops = []
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
})
afterEach(() => {
  stops.forEach((stop) => stop())
  vi.useRealTimers()
  vi.restoreAllMocks()
})
it('polls every minute focused and every five minutes hidden', async () => {
  const read = vi.fn()
  stops.push(installBackofficeAdaptivePoller(read))
  await vi.advanceTimersByTimeAsync(cadence.focusedMs)
  expect(read).toHaveBeenCalledTimes(2)
  visible = false
  document.dispatchEvent(new Event('visibilitychange'))
  await vi.advanceTimersByTimeAsync(cadence.hiddenMs - 1)
  expect(read).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1)
  expect(read).toHaveBeenCalledTimes(3)
})
it('stops at fifteen minutes; twenty hidden idle minutes cost only three reads', async () => {
  visible = false
  const read = vi.fn()
  stops.push(installBackofficeAdaptivePoller(read))
  await vi.advanceTimersByTimeAsync(20 * 60_000)
  expect(read).toHaveBeenCalledTimes(3)
  expect(vi.getTimerCount()).toBe(0)
})
it('focus plus subscribe in one tick share one request', async () => {
  const read = vi.fn(async () => {})
  stops.push(subscribeWorkRefresh('scope', read))
  window.dispatchEvent(new Event('focus'))
  stops.push(subscribeWorkRefresh('scope', read))
  await vi.advanceTimersByTimeAsync(0)
  expect(read).toHaveBeenCalledTimes(1)
})
it('reconciles server unread counts immediately on waking from idle', async () => {
  let serverUnread = 1
  let unread = 0
  stops.push(
    installBackofficeAdaptivePoller(() => {
      unread = serverUnread
    })
  )
  await vi.advanceTimersByTimeAsync(20 * 60_000)
  serverUnread = 5
  expect(unread).toBe(1)
  window.dispatchEvent(new Event('focus'))
  expect(unread).toBe(5)
  await vi.advanceTimersByTimeAsync(cadence.focusedMs)
  serverUnread = 7
  await vi.advanceTimersByTimeAsync(20 * 60_000)
  serverUnread = 9
  document.dispatchEvent(new Event('pointerdown'))
  expect(unread).toBe(9)
})
it('caps each poller at one in-flight read', async () => {
  let finish!: () => void
  const read = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  stops.push(installBackofficeAdaptivePoller(read))
  await vi.advanceTimersByTimeAsync(cadence.focusedMs * 2)
  window.dispatchEvent(new Event('focus'))
  expect(read).toHaveBeenCalledTimes(1)
  finish()
  await vi.advanceTimersByTimeAsync(cadence.focusedMs)
  expect(read).toHaveBeenCalledTimes(2)
  finish()
})
