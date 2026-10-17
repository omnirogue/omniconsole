import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RoomPoller } from './room-poller'
import { RoomError } from './room-error'
import { ID, roomEvent } from '../../shared/room-test-fixtures'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
describe('visible-room polling', () => {
  it('drops cached events on lost membership or account authority', async () => {
    const events = vi
      .fn()
      .mockResolvedValueOnce({ events: [roomEvent('10')], nextCursor: '10' })
      .mockRejectedValueOnce(new RoomError('forbidden'))
      .mockResolvedValueOnce({ events: [roomEvent('20')], nextCursor: '20' })
    const poller = new RoomPoller(ID, { events }, vi.fn())
    poller.setVisible(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(poller.current()).toMatchObject({ events: [], sequence: '0', error: 'forbidden' })
    await vi.advanceTimersByTimeAsync(2000)
    expect(events).toHaveBeenLastCalledWith(ID, 'latest')
    expect(poller.current().events.map((event) => event.sequence)).toEqual(['20'])
    poller.dispose()
  })
  it('starts at latest, ignores lower/equal sequences and tolerates reported gaps', async () => {
    const events = vi
      .fn()
      .mockResolvedValueOnce({ events: [roomEvent('10')], nextCursor: '10' })
      .mockResolvedValueOnce({
        events: [roomEvent('9'), roomEvent('10'), roomEvent('12'), roomEvent('11')],
        nextCursor: '11'
      })
    const publish = vi.fn(),
      poller = new RoomPoller(ID, { events }, publish)
    poller.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(events).toHaveBeenCalledWith(ID, 'latest')
    expect(poller.current().gaps).toEqual([])
    await vi.advanceTimersByTimeAsync(2000)
    expect(events).toHaveBeenLastCalledWith(ID, '10')
    expect(poller.current().events.map((event) => event.sequence)).toEqual(['10', '12'])
    expect(poller.current()).toMatchObject({
      sequence: '12',
      gaps: [{ expected: '11', received: '12' }]
    })
    poller.dispose()
  })
  it('backs off 2,4,8,16,30 seconds and resets after recovery', async () => {
    const events = vi.fn().mockRejectedValue(new RoomError('network_error'))
    const poller = new RoomPoller(ID, { events }, vi.fn())
    poller.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(poller.current().retryMs).toBe(2000)
    for (const [elapsed, retryMs] of [
      [2000, 4000],
      [4000, 8000],
      [8000, 16000],
      [16000, 30000],
      [30000, 30000]
    ]) {
      await vi.advanceTimersByTimeAsync(elapsed)
      expect(poller.current().retryMs).toBe(retryMs)
    }
    events.mockResolvedValue({ events: [], nextCursor: '0' })
    await vi.advanceTimersByTimeAsync(30000)
    expect(poller.current().retryMs).toBe(2000)
    expect(poller.current().error).toBeUndefined()
    poller.dispose()
  })
  it('retains only 500 events and never exposes its mutable buffer', async () => {
    let page = 0
    const events = vi.fn().mockImplementation(async () => ({
      events: Array.from({ length: 100 }, (_, i) => roomEvent(String(page * 100 + i + 1))),
      nextCursor: String(++page * 100)
    }))
    const poller = new RoomPoller(ID, { events }, vi.fn())
    poller.setVisible(true)
    await vi.advanceTimersByTimeAsync(10000)
    expect(poller.current().events).toHaveLength(500)
    expect(poller.current().events[0].sequence).toBe('101')
    poller.current().events.length = 0
    expect(poller.current().events).toHaveLength(500)
    poller.dispose()
  })
  it('stops on hide and discards late responses from the previous visibility generation', async () => {
    let resolve!: (value: { events: ReturnType<typeof roomEvent>[]; nextCursor: string }) => void
    const events = vi.fn().mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const publish = vi.fn(),
      poller = new RoomPoller(ID, { events }, publish)
    poller.setVisible(true)
    poller.setVisible(false)
    resolve({ events: [roomEvent()], nextCursor: '1' })
    await vi.advanceTimersByTimeAsync(60000)
    expect(publish).not.toHaveBeenCalled()
    expect(events).toHaveBeenCalledTimes(1)
  })
})
