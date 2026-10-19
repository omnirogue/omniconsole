import type { OmniRogueCreditBalance } from '../../shared/omnirogue-account'

type CacheTimestamps = {
  /** Unix milliseconds; expiresAt is an exclusive upper bound. */
  cachedAt: number
  expiresAt?: number
}

export type OmniRogueCachedAssetEntry = CacheTimestamps & {
  id: string
  kind: 'image' | 'video' | 'audio'
  localPath: string
}

export type OmniRogueCachedCreditSnapshot = CacheTimestamps & {
  balance: OmniRogueCreditBalance
}

type SerializedIndex = {
  version: 1
  assets: OmniRogueCachedAssetEntry[]
  creditSnapshot: OmniRogueCachedCreditSnapshot | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isNonnegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function readTimestamps(value: Record<string, unknown>): CacheTimestamps {
  if (
    !isNonnegativeNumber(value.cachedAt) ||
    (value.expiresAt !== undefined && !isNonnegativeNumber(value.expiresAt))
  ) {
    throw new TypeError('Invalid OmniRogue cache timestamps')
  }
  return {
    cachedAt: value.cachedAt,
    ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt as number })
  }
}

function readAsset(value: unknown): OmniRogueCachedAssetEntry {
  if (
    !isRecord(value) ||
    !isText(value.id) ||
    !isText(value.localPath) ||
    (value.kind !== 'image' && value.kind !== 'video' && value.kind !== 'audio')
  ) {
    throw new TypeError('Invalid OmniRogue cached asset')
  }
  return {
    id: value.id,
    kind: value.kind,
    localPath: value.localPath,
    ...readTimestamps(value)
  }
}

function readCreditSnapshot(value: unknown): OmniRogueCachedCreditSnapshot {
  if (
    !isRecord(value) ||
    !isRecord(value.balance) ||
    !isNonnegativeNumber(value.balance.availableCredits) ||
    !isText(value.balance.updatedAt)
  ) {
    throw new TypeError('Invalid OmniRogue cached credit snapshot')
  }
  const balance: OmniRogueCreditBalance = {
    availableCredits: value.balance.availableCredits,
    updatedAt: value.balance.updatedAt
  }
  for (const key of ['reservedCredits', 'totalCredits', 'lowBalanceThreshold'] as const) {
    const amount = value.balance[key]
    if (amount !== undefined) {
      if (!isNonnegativeNumber(amount)) {
        throw new TypeError(`Invalid OmniRogue credit snapshot ${key}`)
      }
      balance[key] = amount
    }
  }
  for (const key of ['plan', 'currency'] as const) {
    const text = value.balance[key]
    if (text !== undefined) {
      if (!isText(text)) {
        throw new TypeError(`Invalid OmniRogue credit snapshot ${key}`)
      }
      balance[key] = text
    }
  }
  return { balance, ...readTimestamps(value) }
}

function isExpired(entry: CacheTimestamps, now: number): boolean {
  return entry.expiresAt !== undefined && entry.expiresAt <= now
}

/** One instance per account and execution host; paths are metadata, never filesystem access. */
export class OmniRogueLocalCacheIndex {
  private readonly assets = new Map<string, OmniRogueCachedAssetEntry>()
  private creditSnapshot: OmniRogueCachedCreditSnapshot | undefined
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  upsertAsset(entry: OmniRogueCachedAssetEntry): void {
    const asset = readAsset(entry)
    this.assets.set(asset.id, asset)
  }

  getAsset(id: string): OmniRogueCachedAssetEntry | undefined {
    const asset = this.assets.get(id)
    if (!asset || isExpired(asset, this.now())) {
      return undefined
    }
    return { ...asset }
  }

  listAssetsByKind(kind: OmniRogueCachedAssetEntry['kind']): OmniRogueCachedAssetEntry[] {
    const now = this.now()
    return [...this.assets.values()]
      .filter((asset) => asset.kind === kind && !isExpired(asset, now))
      .map((asset) => ({ ...asset }))
  }

  setCreditSnapshot(snapshot: OmniRogueCachedCreditSnapshot): void {
    this.creditSnapshot = readCreditSnapshot(snapshot)
  }

  getCreditSnapshot(): OmniRogueCachedCreditSnapshot | undefined {
    const snapshot = this.creditSnapshot
    if (!snapshot || isExpired(snapshot, this.now())) {
      return undefined
    }
    return { ...snapshot, balance: { ...snapshot.balance } }
  }

  /** Removes metadata only and returns the number of assets and snapshots removed. */
  pruneExpired(now: number = this.now()): number {
    if (!isNonnegativeNumber(now)) {
      throw new TypeError('Invalid OmniRogue cache pruning timestamp')
    }
    let removed = 0
    for (const [id, asset] of this.assets) {
      if (isExpired(asset, now)) {
        this.assets.delete(id)
        removed++
      }
    }
    if (this.creditSnapshot && isExpired(this.creditSnapshot, now)) {
      this.creditSnapshot = undefined
      removed++
    }
    return removed
  }

  toJSON(): SerializedIndex {
    return {
      version: 1,
      assets: [...this.assets.values()].map((asset) => ({ ...asset })),
      creditSnapshot: this.creditSnapshot
        ? { ...this.creditSnapshot, balance: { ...this.creditSnapshot.balance } }
        : null
    }
  }

  static fromJSON(value: unknown, now: () => number = Date.now): OmniRogueLocalCacheIndex {
    const data: unknown = typeof value === 'string' ? JSON.parse(value) : value
    if (
      !isRecord(data) ||
      data.version !== 1 ||
      !Array.isArray(data.assets) ||
      (data.creditSnapshot !== null && !isRecord(data.creditSnapshot))
    ) {
      throw new TypeError('Invalid OmniRogue local cache index')
    }
    const index = new OmniRogueLocalCacheIndex(now)
    for (const asset of data.assets) {
      index.upsertAsset(readAsset(asset))
    }
    if (data.creditSnapshot !== null) {
      index.setCreditSnapshot(readCreditSnapshot(data.creditSnapshot))
    }
    return index
  }
}
