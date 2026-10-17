// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPeerThreadDeltas } from './peer-thread-deltas'
import { peerMessageProjects, peerMessageThreads } from './peer-messages'
import { PEER_SWEEP_INTERVAL_MS } from '../../../shared/backoffice-polling-cadence'
import type {
  PeerMessageThread,
  PeerMessageThreadPage
} from '../../../shared/peer-message-contract'

vi.mock('./peer-messages', () => ({ peerMessageProjects: vi.fn(), peerMessageThreads: vi.fn() }))
vi.mock('./backoffice-polling-activity', () => ({ isBackofficePollingIdle: () => false }))
vi.mock('./window-park-visibility', () => ({ getWindowParkVisible: () => true }))
const page = (
  id: string,
  next_cursor: string | null,
  project_id = 'closed'
): PeerMessageThreadPage => ({
  threads: [{ id, project_id } as PeerMessageThread],
  next_cursor
})
beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  vi.mocked(peerMessageProjects).mockResolvedValue([{ id: 'closed', name: 'Closed' }])
  vi.mocked(peerMessageThreads).mockImplementation(async (_id, cursor) =>
    cursor ? page('older', 'oldest_cursor') : page('newest', 'older_cursor')
  )
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('opens one older page per click and keeps it through the ordinary newest-page sweep', async () => {
  vi.useFakeTimers()
  const reader = createPeerThreadDeltas()
  expect((await reader.read()).map((row) => row.id)).toEqual(['newest'])
  expect(reader.hasMore()).toBe(true)
  expect((await reader.loadMore()).map((row) => row.id)).toEqual(['newest', 'older'])
  expect(peerMessageThreads).toHaveBeenNthCalledWith(2, 'closed', 'older_cursor')
  await vi.advanceTimersByTimeAsync(PEER_SWEEP_INTERVAL_MS)
  expect((await reader.read()).map((row) => row.id)).toEqual(['newest', 'older'])
  expect(peerMessageThreads).toHaveBeenCalledTimes(3)
  expect(peerMessageThreads).toHaveBeenLastCalledWith('closed', undefined, true)
  vi.mocked(peerMessageThreads).mockResolvedValue(page('oldest', null))
  expect((await reader.loadMore()).map((row) => row.id)).toEqual(['newest', 'older', 'oldest'])
  expect(peerMessageThreads).toHaveBeenLastCalledWith('closed', 'oldest_cursor')
  expect(reader.hasMore()).toBe(false)
})

it('replays the requested depth after deletion and retains the remaining server cursor', async () => {
  const reader = createPeerThreadDeltas()
  await reader.read()
  await reader.loadMore()
  vi.mocked(peerMessageThreads)
    .mockClear()
    .mockImplementation(async (_id, cursor) =>
      cursor
        ? page('replacement_older', 'remaining')
        : page('replacement_newest', 'replacement_cursor')
    )
  reader.invalidate()
  expect((await reader.read()).map((row) => row.id)).toEqual([
    'replacement_newest',
    'replacement_older'
  ])
  expect(peerMessageThreads).toHaveBeenCalledTimes(2)
  expect(reader.hasMore()).toBe(true)
})

it('coalesces load-more clicks, rejects repeated cursors and preserves the retry cursor', async () => {
  const reader = createPeerThreadDeltas()
  await reader.read()
  vi.mocked(peerMessageThreads).mockResolvedValueOnce(page('repeated', 'older_cursor'))
  const first = reader.loadMore()
  expect(reader.loadMore()).toBe(first)
  await expect(first).rejects.toThrow('repeated a page')
  expect((await reader.read()).map((row) => row.id)).toEqual(['newest'])
  vi.mocked(peerMessageThreads).mockResolvedValue(page('older', null))
  expect((await reader.loadMore()).map((row) => row.id)).toEqual(['newest', 'older'])
  expect(peerMessageThreads).toHaveBeenLastCalledWith('closed', 'older_cursor')
})

it('cancels between projects and keeps the completed page for the next selection attempt', async () => {
  vi.mocked(peerMessageProjects).mockResolvedValue([
    { id: 'closed', name: 'Closed' },
    { id: 'another', name: 'Another' }
  ])
  vi.mocked(peerMessageThreads).mockImplementation(async (id) =>
    page(`${id}_new`, 'older_cursor', id)
  )
  const reader = createPeerThreadDeltas()
  await reader.read()
  let cancelled = false
  vi.mocked(peerMessageThreads)
    .mockClear()
    .mockImplementation(async (id) => {
      cancelled = true
      return page(`${id}_old`, null, id)
    })
  expect((await reader.loadMore(() => cancelled)).map((row) => row.id)).toEqual([
    'closed_new',
    'closed_old',
    'another_new'
  ])
  expect(peerMessageThreads).toHaveBeenCalledTimes(1)
  expect(reader.hasMore()).toBe(true)
})

it('does not continue an old account reader after it is disposed', async () => {
  const reader = createPeerThreadDeltas()
  await reader.read()
  reader.dispose()
  await reader.loadMore()
  expect(peerMessageThreads).toHaveBeenCalledTimes(1)
})
