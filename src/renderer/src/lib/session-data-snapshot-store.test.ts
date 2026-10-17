// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createSessionDataSnapshotStore, type SessionDataRead } from './session-data-snapshot-store'

const visibility = vi.hoisted(() => ({ visible: true, listeners: new Set<() => void>() }))
vi.mock('./window-park-visibility', () => ({
  getWindowParkVisible: () => visibility.visible,
  subscribeWindowParkVisibility: (listener: () => void) => {
    visibility.listeners.add(listener)
    return () => visibility.listeners.delete(listener)
  }
}))
const stops: (() => void)[] = []
beforeEach(() => {
  vi.useFakeTimers()
  visibility.visible = true
})
afterEach(() => {
  stops.splice(0).forEach((stop) => stop())
  vi.useRealTimers()
})
const flush = () => vi.advanceTimersByTimeAsync(0)
function store(
  read = vi.fn<() => Promise<SessionDataRead<string[]>>>().mockResolvedValue({ data: [] }),
  intervalMs = 3000
) {
  return {
    read,
    store: createSessionDataSnapshotStore({
      initial: [] as string[],
      intervalMs,
      read,
      empty: (data) => data.length === 0
    })
  }
}

it.each([2000, 3000, 60_000])(
  'shares one serial loop at the native %i ms cadence and stops without visible readers',
  async (interval) => {
    const { store: snapshot, read } = store(undefined, interval)
    stops.push(snapshot.subscribe(vi.fn(), false))
    await vi.advanceTimersByTimeAsync(interval * 2)
    expect(read).not.toHaveBeenCalled()
    const first = snapshot.subscribe(vi.fn())
    const second = snapshot.subscribe(vi.fn())
    stops.push(first, second)
    await flush()
    expect(read).toHaveBeenCalledTimes(1)
    first()
    await vi.advanceTimersByTimeAsync(interval)
    expect(read).toHaveBeenCalledTimes(2)
    second()
    await vi.advanceTimersByTimeAsync(interval * 2)
    expect(read).toHaveBeenCalledTimes(2)
    stops.push(snapshot.subscribe(vi.fn()))
    await flush()
    expect(read).toHaveBeenCalledTimes(3)
  }
)

it('uses five minutes for a hidden window and refreshes on restore', async () => {
  const { store: snapshot, read } = store()
  stops.push(snapshot.subscribe(vi.fn()))
  await flush()
  visibility.visible = false
  visibility.listeners.forEach((listener) => listener())
  await vi.advanceTimersByTimeAsync(299_999)
  expect(read).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(read).toHaveBeenCalledTimes(2)
  visibility.visible = true
  visibility.listeners.forEach((listener) => listener())
  await flush()
  expect(read).toHaveBeenCalledTimes(3)
})

it('distinguishes initial failures, healthy empty, stale data and recovery with success time', async () => {
  const { store: snapshot, read } = store()
  expect(snapshot.getSnapshot().status).toBe('loading')
  read.mockResolvedValueOnce({ issue: 'signed-out' })
  await snapshot.refresh()
  expect(snapshot.getSnapshot()).toMatchObject({ status: 'signed-out', lastSuccessAt: null })
  read.mockRejectedValueOnce(new Error('offline'))
  await snapshot.refresh()
  expect(snapshot.getSnapshot()).toMatchObject({ status: 'unavailable', error: 'offline' })
  await snapshot.refresh()
  expect(snapshot.getSnapshot().status).toBe('healthy-empty')
  read.mockResolvedValueOnce({ data: ['last good'] })
  await snapshot.refresh()
  const at = snapshot.getSnapshot().lastSuccessAt
  read.mockResolvedValueOnce({ data: [], issue: 'unavailable' })
  await snapshot.refresh()
  expect(snapshot.getSnapshot()).toMatchObject({
    status: 'stale',
    data: ['last good'],
    lastSuccessAt: at
  })
  await snapshot.refresh()
  expect(snapshot.getSnapshot()).toMatchObject({
    status: 'healthy-empty',
    issue: null,
    error: null
  })
})

it('fences a pending read after a write and serializes concurrent writes', async () => {
  let finishRead!: (value: SessionDataRead<string[]>) => void
  const { store: snapshot, read } = store(
    vi.fn(
      () =>
        new Promise<SessionDataRead<string[]>>((resolve) => {
          finishRead = resolve
        })
    )
  )
  const reading = snapshot.refresh()
  await flush()
  let finishWrite!: (value: string[]) => void
  const first = snapshot.mutate(
    () =>
      new Promise<string[]>((resolve) => {
        finishWrite = resolve
      })
  )
  const next = vi.fn(async (previous: string[]) => [...previous, 'second'])
  const second = snapshot.mutate(next)
  await flush()
  finishRead({ data: ['obsolete'] })
  await reading
  expect(snapshot.getSnapshot().data).toEqual([])
  expect(next).not.toHaveBeenCalled()
  finishWrite(['first'])
  await Promise.all([first, second])
  expect(snapshot.getSnapshot().data).toEqual(['first', 'second'])
  expect(read).toHaveBeenCalledTimes(1)
})

it('does not publish a late response into a changed account or runtime', async () => {
  let current = true
  let resolve!: (value: SessionDataRead<string[]>) => void
  const snapshot = createSessionDataSnapshotStore({
    initial: [] as string[],
    intervalMs: 3000,
    empty: (data) => data.length === 0,
    current: () => current,
    read: () =>
      new Promise<SessionDataRead<string[]>>((done) => {
        resolve = done
      })
  })
  const reading = snapshot.refresh()
  await flush()
  current = false
  resolve({ data: ['private predecessor'] })
  await reading
  expect(snapshot.getSnapshot().status).toBe('loading')
  await expect(snapshot.mutate(async () => ['wrong owner'])).rejects.toThrow(
    'account or runtime changed'
  )
})
