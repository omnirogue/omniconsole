import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PeerInboxReceiver, type PeerInboxReceiverOwner } from './peer-inbox-receiver'
const binding = { key: 'exact-conversation' }
let receiver: PeerInboxReceiver<typeof binding>
let current: boolean
let owner: PeerInboxReceiverOwner<typeof binding>
const read = vi.fn()
const submit = vi.fn()
beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(0)
  current = true
  read
    .mockReset()
    .mockResolvedValue({ schema_version: 1, pending: 1, available: 1, leased: 0, blocked: 0 })
  submit.mockReset().mockResolvedValue('submitted')
  owner = {
    isCurrent: () => current,
    readPending: read,
    admit: () => 'ready',
    loadAttempt: async () => null,
    persistAttempt: async () => undefined,
    clearAttempt: async () => undefined,
    submitHint: submit,
    observeAttempt: async () => 'unresolved'
  }
  receiver = new PeerInboxReceiver(binding, owner, { pollIntervalMs: 100 })
})
afterEach(() => {
  receiver.dispose()
  vi.restoreAllMocks()
  vi.useRealTimers()
})
it('backs off failed checks despite owner event storms and recovers exactly once', async () => {
  read
    .mockRejectedValueOnce(new Error('connection lost'))
    .mockRejectedValueOnce(new Error('still unavailable'))
  receiver.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(receiver.getStatus()).toMatchObject({
    phase: 'error',
    consecutiveFailures: 1,
    nextCheckAt: Date.now() + 100
  })
  for (let i = 0; i < 100; i++) {
    receiver.notifyOwnerChanged()
  }
  await vi.advanceTimersByTimeAsync(99)
  expect(read).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(receiver.getStatus()).toMatchObject({
    consecutiveFailures: 2,
    nextCheckAt: Date.now() + 200
  })
  await vi.advanceTimersByTimeAsync(200)
  expect(submit).toHaveBeenCalledTimes(1)
  expect(receiver.getStatus()).toMatchObject({
    phase: 'awaiting-completion',
    consecutiveFailures: 0,
    lastPendingCheckAt: Date.now()
  })
  expect(receiver.getStatus().nextCheckAt).toBeUndefined()
  await vi.advanceTimersByTimeAsync(1000)
  expect(submit).toHaveBeenCalledTimes(1)
})
it('a status read retires a stale binding without reading or consuming the inbox', async () => {
  receiver.start()
  current = false
  expect(receiver.getStatus().phase).toBe('revoked')
  await vi.advanceTimersByTimeAsync(1000)
  expect(read).not.toHaveBeenCalled()
  expect(submit).not.toHaveBeenCalled()
})
it('stops recovery after detach and ignores a late response', async () => {
  read.mockRejectedValueOnce(new Error('unreachable'))
  receiver.start()
  await vi.advanceTimersByTimeAsync(0)
  receiver.dispose()
  await vi.advanceTimersByTimeAsync(60000)
  expect(read).toHaveBeenCalledTimes(1)
  expect(receiver.getStatus().phase).toBe('stopped')
  expect(receiver.getStatus().nextCheckAt).toBeUndefined()
})
it('caps retry delays and never admits input while pending checks fail', async () => {
  read.mockRejectedValue(new Error('unreachable'))
  receiver.start()
  await vi.advanceTimersByTimeAsync(180000)
  const status = receiver.getStatus()
  expect(status.consecutiveFailures).toBeGreaterThan(8)
  expect(status.nextCheckAt! - Date.now()).toBeLessThanOrEqual(60000)
  expect(read.mock.calls.length).toBeLessThan(20)
  expect(submit).not.toHaveBeenCalled()
})
