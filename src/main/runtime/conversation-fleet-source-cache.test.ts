import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { FleetSourceSnapshotCache } from './conversation-fleet-source-cache'
import { FLEET_SOURCE_CHUNK_BYTES } from '../../shared/conversation-fleet-source-snapshot'

afterEach(() => vi.useRealTimers())
function fixture(content: Buffer) {
  const id = randomUUID()
  return {
    manifest: {
      snapshotId: randomUUID(),
      files: [
        {
          id,
          name: 'source.bin',
          size: content.length,
          sha256: createHash('sha256').update(content).digest('hex'),
          targetPath: 'source.bin',
          executable: false
        }
      ],
      deletions: [],
      warnings: [],
      source: { connectionId: null }
    },
    bytes: new Map([[id, content]])
  }
}
describe('caller-owned immutable source snapshot cache', () => {
  it('reads exact pinned chunks across transport frames and refuses other callers', async () => {
    const cache = new FleetSourceSnapshotCache()
    const bytes = Buffer.alloc(FLEET_SOURCE_CHUNK_BYTES + 8, 255)
    const result = await cache.capture('alice', async () => fixture(bytes))
    const request = { snapshotId: result.snapshotId, fileId: result.files[0].id, offset: 0 }
    expect(() => cache.read('bob', request)).toThrow(/unavailable/)
    expect(() => cache.release('bob', result.snapshotId)).toThrow(/unavailable/)
    const first = cache.read('alice', request)
    expect(first.complete).toBe(false)
    expect(Buffer.from(first.contentBase64, 'base64')).toEqual(
      bytes.subarray(0, FLEET_SOURCE_CHUNK_BYTES)
    )
    const final = cache.read('alice', { ...request, offset: first.nextOffset })
    expect(final.complete).toBe(true)
    expect(final.nextOffset).toBe(bytes.length)
    expect(Buffer.from(final.contentBase64, 'base64')).toEqual(
      bytes.subarray(FLEET_SOURCE_CHUNK_BYTES)
    )
    expect(cache.release('alice', result.snapshotId)).toEqual({ released: true })
    expect(() => cache.read('alice', request)).toThrow(/unavailable/)
  })

  it('expires captured bytes and refuses duplicate concurrent captures by one caller', async () => {
    vi.useFakeTimers()
    const cache = new FleetSourceSnapshotCache()
    let finish!: (value: ReturnType<typeof fixture>) => void
    const pending = cache.capture(
      'alice',
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    await expect(cache.capture('alice', async () => fixture(Buffer.alloc(0)))).rejects.toThrow(
      /already/
    )
    finish(fixture(Buffer.from('snapshot')))
    const result = await pending
    vi.advanceTimersByTime(10 * 60 * 1000)
    expect(() =>
      cache.read('alice', { snapshotId: result.snapshotId, fileId: result.files[0].id, offset: 0 })
    ).toThrow(/expired/)
  })
})
