import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionChain } from '../../shared/session-chain-types'

const mocks = vi.hoisted(() => ({
  steps: [] as { title: string }[],
  keepGoing: false,
  deliveries: [] as { target: { paneKey: string }; settled: boolean }[],
  waiters: [] as string[]
}))
vi.mock('../session-manage/session-manage-runtime-sources', () => ({
  readRuntimeOwnSteps: vi.fn(async () => ({ set: null, steps: mocks.steps })),
  isKeepGoingOn: () => mocks.keepGoing
}))
vi.mock('../session-manage/session-pending-deliveries-runtime', () => ({
  getSessionPendingDeliveries: () => ({ list: () => mocks.deliveries })
}))
vi.mock('../../shared/session-pending-delivery-types', () => ({
  isSessionPendingDeliverySettled: (delivery: { settled: boolean }) => delivery.settled
}))
vi.mock('../session-steward/steward-waiter-source', () => ({
  sessionWaitersOf: () => mocks.waiters
}))

const { readUpNextArchiveReadings, readUpNextIdleArchiveClear } =
  await import('./up-next-idle-archive')
const { readRuntimeOwnSteps } = await import('../session-manage/session-manage-runtime-sources')

const source = { worktreeId: 'wt', paneKey: 'tab-1:leaf-1', kind: 'pty' as const }
const rowKey = 'row'
const finished = { finishReady: true, archiveHasWork: false, queuedCount: 0, draftCount: 0 }
const clear = (
  view: Partial<typeof finished> = {},
  chains: Partial<SessionChain>[] = []
): Promise<boolean> =>
  readUpNextIdleArchiveClear(source, rowKey, chains as SessionChain[], { ...finished, ...view })

beforeEach(() => {
  mocks.steps = []
  mocks.keepGoing = false
  mocks.deliveries = []
  mocks.waiters = []
})

it('reads a finished conversation with no plan and nothing pending as clear', async () => {
  expect(await clear()).toBe(true)
  // Another conversation's chain and a settled held prompt are not this one's.
  mocks.deliveries = [{ target: { paneKey: source.paneKey }, settled: true }]
  expect(await clear({}, [{ sourceRowKey: 'other-row' }])).toBe(true)
})

it.each([
  ['an ask or an unfinished turn', { finishReady: false }],
  ['busy or background work', { archiveHasWork: true }],
  ['a queued prompt', { queuedCount: 1 }],
  ['a draft', { draftCount: 1 }]
])('is not clear with %s', async (_name, view) => {
  expect(await clear(view)).toBe(false)
})

it('is not clear with any plan bound to it, finished or not', async () => {
  expect(await clear({}, [{ sourceRowKey: rowKey, state: 'done' }])).toBe(false)
})

it('is not clear while waiting for a yes, kept going, holding a prompt or awaited', async () => {
  mocks.steps = [{ title: 'Should I open the PR?' }]
  expect(await clear()).toBe(false)
  mocks.steps = []
  mocks.keepGoing = true
  expect(await clear()).toBe(false)
  mocks.keepGoing = false
  mocks.deliveries = [{ target: { paneKey: source.paneKey }, settled: false }]
  expect(await clear()).toBe(false)
  mocks.deliveries = []
  mocks.waiters = ['tab-9:leaf-1']
  expect(await clear()).toBe(false)
})

describe('the archive sleep reading', () => {
  const idle = { ...finished, free: true, queueDelivery: false }
  const read = (
    view: Partial<typeof idle> = {},
    chains: Partial<SessionChain>[] = []
  ): ReturnType<typeof readUpNextArchiveReadings> =>
    readUpNextArchiveReadings(source, rowKey, chains as SessionChain[], { ...idle, ...view })

  it('clears a free conversation with nothing pending, with or without a finished plan', async () => {
    expect(await read()).toEqual({ idleArchiveClear: true, archiveSleepClear: true })
    expect(await read({}, [{ sourceRowKey: rowKey, state: 'done' }])).toEqual({
      idleArchiveClear: false,
      archiveSleepClear: true
    })
  })

  it('clears an agent sitting at its own prompt with no finished turn', async () => {
    expect(await read({ finishReady: false })).toEqual({
      idleArchiveClear: false,
      archiveSleepClear: true
    })
  })

  it.each([
    ['in flight, asking or unreadable', { free: false, finishReady: false }],
    ['busy or background work', { archiveHasWork: true }],
    ['a queued prompt', { queuedCount: 1 }],
    ['a draft', { draftCount: 1 }]
  ])('is not clear with %s, and skips the costly readings', async (_name, view) => {
    vi.mocked(readRuntimeOwnSteps).mockClear()
    expect((await read(view)).archiveSleepClear).toBe(false)
    expect(readRuntimeOwnSteps).not.toHaveBeenCalled()
  })

  it('is not clear while waiting for a yes, kept going, holding a prompt or awaited', async () => {
    mocks.steps = [{ title: 'Should I open the PR?' }]
    expect((await read()).archiveSleepClear).toBe(false)
    mocks.steps = []
    mocks.keepGoing = true
    expect((await read()).archiveSleepClear).toBe(false)
    mocks.keepGoing = false
    mocks.deliveries = [{ target: { paneKey: source.paneKey }, settled: false }]
    expect((await read()).archiveSleepClear).toBe(false)
    mocks.deliveries = []
    mocks.waiters = ['tab-9:leaf-1']
    expect((await read()).archiveSleepClear).toBe(false)
  })

  it('is not clear while a queued prompt is being sent or was just typed in', async () => {
    // The Done archive does not read it; only the sleep that would stop the agent mid-delivery.
    expect(await read({ queueDelivery: true })).toEqual({
      idleArchiveClear: true,
      archiveSleepClear: false
    })
  })

  it('is not clear when a costly reading fails', async () => {
    vi.mocked(readRuntimeOwnSteps).mockRejectedValueOnce(new Error('unreadable'))
    expect(await read()).toEqual({ idleArchiveClear: false, archiveSleepClear: false })
  })
})
