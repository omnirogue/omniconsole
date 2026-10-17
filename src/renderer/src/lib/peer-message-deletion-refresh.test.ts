// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPeerThreadDeltas } from './peer-thread-deltas'
import { peerMessageProjects, peerMessageThreads } from './peer-messages'
import type {
  PeerMessageThread,
  PeerMessageThreadPage
} from '../../../shared/peer-message-contract'

vi.mock('./peer-messages', () => ({ peerMessageProjects: vi.fn(), peerMessageThreads: vi.fn() }))
vi.mock('./backoffice-polling-activity', () => ({ isBackofficePollingIdle: () => false }))
vi.mock('./window-park-visibility', () => ({ getWindowParkVisible: () => true }))
const message = { id: 'original', project_id: 'closed' } as PeerMessageThread
const page = (threads: PeerMessageThread[]): PeerMessageThreadPage => ({
  threads,
  next_cursor: null
})
beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  vi.mocked(peerMessageProjects).mockResolvedValue([{ id: 'closed', name: 'Closed project' }])
  vi.mocked(peerMessageThreads).mockResolvedValue(page([message]))
})
afterEach(() => vi.restoreAllMocks())

it('removes confirmed deletions from a closed project before the next scheduled sweep', async () => {
  const reader = createPeerThreadDeltas()
  expect(await reader.read()).toEqual([message])
  vi.mocked(peerMessageThreads).mockResolvedValue(page([]))
  expect(await reader.read()).toEqual([message])
  reader.invalidate()
  expect(await reader.read()).toEqual([])
  expect(peerMessageThreads).toHaveBeenCalledTimes(2)
})

it('reconciles deletion after an older in-flight sweep completes', async () => {
  let resolve!: (page: PeerMessageThreadPage) => void
  vi.mocked(peerMessageThreads).mockReturnValueOnce(
    new Promise((done) => {
      resolve = done
    })
  )
  const reader = createPeerThreadDeltas()
  const older = reader.read()
  await vi.waitFor(() => expect(peerMessageThreads).toHaveBeenCalledTimes(1))
  reader.invalidate()
  const afterDelete = reader.read()
  vi.mocked(peerMessageThreads).mockResolvedValue(page([]))
  resolve(page([message]))
  expect(await older).toEqual([message])
  expect(await afterDelete).toEqual([])
  expect(peerMessageThreads).toHaveBeenCalledTimes(2)
})
