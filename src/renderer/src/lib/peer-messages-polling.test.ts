// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPeerThreadDeltas } from './peer-thread-deltas'
import { noteBackofficeActivity } from './backoffice-polling-activity'
import { installBackofficeAdaptivePoller } from './backoffice-adaptive-poller'
import { subscribeWorkRefresh } from '@/components/task-page/backoffice/backoffice-work-refresh'
import { PEER_SWEEP_INTERVAL_MS } from '../../../shared/backoffice-polling-cadence'

let visible = true
const feed = vi.fn()
let stops: (() => void)[] = []
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
  noteBackofficeActivity()
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  Object.defineProperty(window, 'api', { configurable: true, value: { backoffice: { feed } } })
  feed.mockReset().mockImplementation(async ({ path }: { path: string }) => ({
    ok: true,
    body: path.endsWith('/projects')
      ? {
          projects: [
            { id: 'open', name: 'Open' },
            { id: 'closed', name: 'Closed' }
          ]
        }
      : { threads: [], next_cursor: path.includes('cursor=') ? null : 'next' }
  }))
})
afterEach(() => {
  stops.forEach((stop) => stop())
  stops = []
  vi.restoreAllMocks()
  vi.useRealTimers()
})
const calls = (id: string) =>
  feed.mock.calls.filter(([args]) => args.path.includes(`project_id=${id}`))
it('a focused minute pages only the selected project; the sweep reads one closed page', async () => {
  const reader = createPeerThreadDeltas()
  reader.select('open')
  await reader.read()
  expect(calls('open')).toHaveLength(2)
  expect(calls('closed')).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(60_000)
  await reader.read()
  expect(calls('open')).toHaveLength(4)
  expect(calls('closed')).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(PEER_SWEEP_INTERVAL_MS - 60_000)
  noteBackofficeActivity()
  await reader.read()
  expect(calls('closed')).toHaveLength(2)
  expect(calls('closed').every(([args]) => !args.path.includes('cursor='))).toBe(true)
})
it('opening a closed project performs exactly one page walk, coalescing concurrent readers', async () => {
  const reader = createPeerThreadDeltas()
  await reader.read()
  feed.mockClear()
  reader.select('closed')
  await Promise.all([reader.read(), reader.read()])
  expect(calls('closed')).toHaveLength(2)
  expect(calls('closed').map(([args]) => args.path)).toEqual([
    '/api/estate/peers/threads?project_id=closed&limit=20',
    '/api/estate/peers/threads?project_id=closed&limit=20&cursor=next'
  ])
  expect(calls('open')).toHaveLength(0)
})
it('twenty hidden then idle minutes make exactly zero outbound peer feed calls', async () => {
  visible = false
  const reader = createPeerThreadDeltas()
  reader.select('open')
  stops.push(
    installBackofficeAdaptivePoller(async (wake) => {
      if (wake) {
        reader.wake()
      }
      await reader.read()
    })
  )
  await vi.advanceTimersByTimeAsync(20 * 60_000)
  expect(feed).toHaveBeenCalledTimes(0)
  expect(vi.getTimerCount()).toBe(0)
})
it('wake reconciles once despite visibility, focus and subscription arriving together', async () => {
  visible = false
  const reader = createPeerThreadDeltas()
  const refresh = async (wake?: boolean) => {
    if (wake) {
      reader.wake()
    }
    await reader.read()
  }
  stops.push(subscribeWorkRefresh('wake', refresh))
  await vi.advanceTimersByTimeAsync(20 * 60_000)
  visible = true
  document.dispatchEvent(new Event('visibilitychange'))
  window.dispatchEvent(new Event('focus'))
  stops.push(subscribeWorkRefresh('wake', refresh))
  await vi.advanceTimersByTimeAsync(0)
  expect(feed).toHaveBeenCalledTimes(3)
  expect(calls('closed')).toHaveLength(1)
  expect(calls('open')).toHaveLength(1)
})
it('focus and subscribe in one tick produce exactly one outbound call for an empty estate', async () => {
  feed.mockResolvedValue({ ok: true, body: { projects: [] } })
  const reader = createPeerThreadDeltas()
  const refresh = async () => {
    await reader.read()
  }
  stops.push(subscribeWorkRefresh('empty', refresh))
  window.dispatchEvent(new Event('focus'))
  stops.push(subscribeWorkRefresh('empty', refresh))
  await vi.advanceTimersByTimeAsync(0)
  expect(feed).toHaveBeenCalledTimes(1)
})
it('304 preserves the snapshot and does not request another page', async () => {
  const reader = createPeerThreadDeltas()
  reader.select('open')
  const first = await reader.read()
  feed.mockClear().mockResolvedValue({ ok: true, notModified: true, body: {} })
  await vi.advanceTimersByTimeAsync(60_000)
  expect(await reader.read()).toBe(first)
  expect(feed).toHaveBeenCalledTimes(1)
  expect(feed.mock.calls[0][0].path).not.toContain('cursor=')
})

it('opening a closed project still follows its cursor when the cached first page is 304', async () => {
  const reader = createPeerThreadDeltas()
  await reader.read()
  feed.mockClear().mockImplementation(async ({ path }: { path: string }) => ({
    ok: true,
    notModified: !path.includes('cursor='),
    body: { threads: [], next_cursor: path.includes('cursor=') ? null : 'next' }
  }))
  reader.select('closed')
  await reader.read()
  expect(feed).toHaveBeenCalledTimes(2)
  expect(feed.mock.calls[1][0].path).toContain('cursor=next')
})

it('opening during a sweep waits for its in-flight request, then pages the selected project once', async () => {
  let finish!: (result: unknown) => void
  feed.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  const reader = createPeerThreadDeltas()
  const sweep = reader.read()
  await vi.advanceTimersByTimeAsync(0)
  reader.select('closed')
  const opened = reader.read()
  finish({
    ok: true,
    body: {
      projects: [
        { id: 'open', name: 'Open' },
        { id: 'closed', name: 'Closed' }
      ]
    }
  })
  await Promise.all([sweep, opened])
  expect(feed.mock.calls[1][0].path).toContain('project_id=closed')
  expect(calls('closed')).toHaveLength(2)
  expect(calls('open')).toHaveLength(1)
})
it('a short hide forces one reconciliation before the ten-minute sweep is due', async () => {
  const reader = createPeerThreadDeltas()
  await reader.read()
  const refresh = async (wake?: boolean) => {
    if (wake) {
      reader.wake()
    }
    await reader.read()
  }
  stops.push(subscribeWorkRefresh('short-hide', refresh))
  visible = false
  document.dispatchEvent(new Event('visibilitychange'))
  await vi.advanceTimersByTimeAsync(60_000)
  feed.mockClear()
  visible = true
  document.dispatchEvent(new Event('visibilitychange'))
  window.dispatchEvent(new Event('focus'))
  await vi.advanceTimersByTimeAsync(0)
  expect(feed).toHaveBeenCalledTimes(3)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(feed).toHaveBeenCalledTimes(3)
})
it('retains a sweep failure instead of publishing an empty successful unread snapshot on the next tick', async () => {
  const reader = createPeerThreadDeltas()
  feed.mockImplementation(async ({ path }: { path: string }) =>
    path.endsWith('/projects')
      ? { ok: true, body: { projects: [{ id: 'closed', name: 'Closed' }] } }
      : { ok: false, message: 'HTTP 502' }
  )
  await expect(reader.read()).rejects.toThrow('HTTP 502')
  await vi.advanceTimersByTimeAsync(60_000)
  await expect(reader.read()).rejects.toThrow('HTTP 502')
  expect(feed).toHaveBeenCalledTimes(2)
})
it('reconciles cached unread state from actual thread responses on idle wake', async () => {
  let state = 'delivered'
  const thread = () => ({
    id: 'message',
    project_id: 'closed',
    task_id: null,
    sender_session_id: 'sender',
    recipient_session_id: 'recipient',
    sender_employee_id: 'sender',
    recipient_employee_id: 'recipient',
    purpose: 'question',
    summary: 'Read me',
    state,
    created_at: 1,
    delivered_at: 1,
    replied_at: null,
    resolved_at: state === 'resolved' ? 2 : null,
    expires_at: null,
    reply: null
  })
  feed.mockImplementation(async ({ path }: { path: string }) => ({
    ok: true,
    body: path.endsWith('/projects')
      ? { projects: [{ id: 'closed', name: 'Closed' }] }
      : { threads: [thread()], next_cursor: null }
  }))
  const reader = createPeerThreadDeltas()
  let unread = 0
  const refresh = async (wake?: boolean) => {
    if (wake) {
      reader.wake()
    }
    unread = (await reader.read()).filter((row) => row.state === 'delivered').length
  }
  await refresh()
  expect(unread).toBe(1)
  stops.push(subscribeWorkRefresh('unread', refresh))
  visible = false
  document.dispatchEvent(new Event('visibilitychange'))
  await vi.advanceTimersByTimeAsync(20 * 60_000)
  state = 'resolved'
  expect(unread).toBe(1)
  expect(feed).toHaveBeenCalledTimes(2)
  visible = true
  document.dispatchEvent(new Event('visibilitychange'))
  window.dispatchEvent(new Event('focus'))
  await vi.advanceTimersByTimeAsync(0)
  expect(unread).toBe(0)
  expect(feed).toHaveBeenCalledTimes(4)
})
it('focus plus subscribe makes one outbound open-project call in an already loaded estate', async () => {
  feed.mockImplementation(async ({ path }: { path: string }) => ({
    ok: true,
    body: path.endsWith('/projects')
      ? {
          projects: [
            { id: 'open', name: 'Open' },
            { id: 'closed', name: 'Closed' }
          ]
        }
      : { threads: [], next_cursor: null }
  }))
  const reader = createPeerThreadDeltas()
  reader.select('open')
  await reader.read()
  await vi.advanceTimersByTimeAsync(60_000)
  feed.mockClear()
  const refresh = async () => {
    await reader.read()
  }
  stops.push(subscribeWorkRefresh('loaded-estate', refresh))
  window.dispatchEvent(new Event('focus'))
  stops.push(subscribeWorkRefresh('loaded-estate', refresh))
  await vi.advanceTimersByTimeAsync(0)
  expect(feed).toHaveBeenCalledTimes(1)
  expect(calls('open')).toHaveLength(1)
  expect(calls('closed')).toHaveLength(0)
})
it('does not lose a wake arriving while a skipped hidden read is completing', async () => {
  visible = false
  const reader = createPeerThreadDeltas()
  const hidden = reader.read()
  visible = true
  noteBackofficeActivity()
  reader.wake()
  await Promise.all([hidden, reader.read()])
  expect(feed).toHaveBeenCalledTimes(3)
})
