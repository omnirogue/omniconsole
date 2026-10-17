import {
  FLEET_SOURCE_CHUNK_BYTES,
  type CaptureFleetSourceResult,
  type ReadFleetSourceChunkRequest,
  type ReadFleetSourceChunkResult
} from '../../shared/conversation-fleet-source-snapshot'
import type { CapturedFleetSource } from './conversation-fleet-source-snapshot'

const SNAPSHOT_TTL_MS = 10 * 60 * 1000
const CACHE_MAX_BYTES = 64 * 1024 * 1024
const CACHE_MAX_SNAPSHOTS = 4
type CachedSnapshot = CapturedFleetSource & {
  owner: string
  expires: number
  timer: NodeJS.Timeout
}

export class FleetSourceSnapshotCache {
  private readonly snapshots = new Map<string, CachedSnapshot>()
  private readonly pendingOwners = new Set<string>()

  async capture(
    owner: string,
    capture: () => Promise<CapturedFleetSource>
  ): Promise<CaptureFleetSourceResult> {
    if (this.pendingOwners.has(owner) || this.pendingOwners.size >= 2) {
      throw new Error(
        'A source snapshot is already being captured. Wait for it to finish and try again.'
      )
    }
    this.pendingOwners.add(owner)
    try {
      const snapshot = await capture()
      const bytes = [...this.snapshots.values(), snapshot].reduce(
        (total, entry) => total + entry.manifest.files.reduce((size, file) => size + file.size, 0),
        0
      )
      if (bytes > CACHE_MAX_BYTES || this.snapshots.size >= CACHE_MAX_SNAPSHOTS) {
        throw new Error('The source snapshot cache is full. Finish another dispatch and try again.')
      }
      const id = snapshot.manifest.snapshotId
      const timer = setTimeout(() => this.snapshots.delete(id), SNAPSHOT_TTL_MS)
      timer.unref()
      this.snapshots.set(id, { ...snapshot, owner, expires: Date.now() + SNAPSHOT_TTL_MS, timer })
      return snapshot.manifest
    } finally {
      this.pendingOwners.delete(owner)
    }
  }

  private require(owner: string, id: string): CachedSnapshot {
    const entry = this.snapshots.get(id)
    if (!entry || entry.owner !== owner || entry.expires <= Date.now()) {
      throw new Error('The source snapshot is unavailable or expired. Capture the workspace again.')
    }
    return entry
  }

  read(owner: string, request: ReadFleetSourceChunkRequest): ReadFleetSourceChunkResult {
    const bytes = this.require(owner, request.snapshotId).bytes.get(request.fileId)
    if (!bytes || request.offset > bytes.length) {
      throw new Error('The requested source snapshot file or offset is unavailable.')
    }
    const nextOffset = Math.min(
      bytes.length,
      request.offset + (request.limit ?? FLEET_SOURCE_CHUNK_BYTES)
    )
    return {
      contentBase64: bytes.subarray(request.offset, nextOffset).toString('base64'),
      nextOffset,
      complete: nextOffset === bytes.length
    }
  }

  release(owner: string, id: string): { released: boolean } {
    const snapshot = this.snapshots.get(id)
    if (!snapshot) {
      return { released: false }
    }
    this.require(owner, id)
    clearTimeout(snapshot.timer)
    return { released: this.snapshots.delete(id) }
  }
}
