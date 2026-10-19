import { describe, expect, it } from 'vitest'
import {
  OmniRogueLocalCacheIndex,
  type OmniRogueCachedAssetEntry,
  type OmniRogueCachedCreditSnapshot
} from './omnirogue-local-cache-index'

const asset = (overrides: Partial<OmniRogueCachedAssetEntry> = {}): OmniRogueCachedAssetEntry => ({
  id: 'asset-1',
  kind: 'image',
  localPath: '/cache/image.png',
  cachedAt: 100,
  expiresAt: 200,
  ...overrides
})

const credits = (): OmniRogueCachedCreditSnapshot => ({
  cachedAt: 100,
  expiresAt: 200,
  balance: {
    availableCredits: 12.5,
    reservedCredits: 2,
    totalCredits: 14.5,
    lowBalanceThreshold: 5,
    updatedAt: '2026-10-16T00:00:00Z',
    plan: 'pro',
    currency: 'credits'
  }
})

describe('OmniRogueLocalCacheIndex', () => {
  it('starts empty and keeps instances isolated', () => {
    const index = new OmniRogueLocalCacheIndex(() => 150)
    expect(index.getAsset('missing')).toBeUndefined()
    expect(index.listAssetsByKind('image')).toEqual([])
    expect(index.getCreditSnapshot()).toBeUndefined()
    expect(index.pruneExpired()).toBe(0)
    index.upsertAsset(asset())
    index.setCreditSnapshot(credits())
    expect(new OmniRogueLocalCacheIndex().toJSON()).toEqual({
      version: 1,
      assets: [],
      creditSnapshot: null
    })
  })

  it('replaces matching IDs and filters the current media kind', () => {
    const index = new OmniRogueLocalCacheIndex(() => 150)
    index.upsertAsset(asset())
    index.upsertAsset(asset({ kind: 'video', localPath: 'C:\\cache\\clip.mp4' }))
    index.upsertAsset(asset({ id: 'sound', kind: 'audio', localPath: '/cache/sound.wav' }))
    expect(index.getAsset('asset-1')?.localPath).toBe('C:\\cache\\clip.mp4')
    expect(index.listAssetsByKind('image')).toEqual([])
    expect(index.listAssetsByKind('video')).toHaveLength(1)
    expect(index.listAssetsByKind('audio').map((entry) => entry.id)).toEqual(['sound'])
    expect(index.toJSON().assets).toHaveLength(2)
  })

  it('does not expose mutable asset references', () => {
    const index = new OmniRogueLocalCacheIndex(() => 150)
    const input = asset()
    index.upsertAsset(input)
    input.localPath = 'changed-input'
    index.getAsset(input.id)!.localPath = 'changed-result'
    index.listAssetsByKind('image')[0].localPath = 'changed-list'
    index.toJSON().assets[0].localPath = 'changed-json'
    expect(index.getAsset(input.id)).toEqual(asset())
  })

  it('hides expired entries at the exact boundary and prunes only expired metadata', () => {
    let now = 199
    const index = new OmniRogueLocalCacheIndex(() => now)
    index.upsertAsset(asset())
    index.upsertAsset(asset({ id: 'permanent', expiresAt: undefined }))
    index.upsertAsset(asset({ id: 'later', expiresAt: 201 }))
    index.setCreditSnapshot(credits())
    expect(index.getAsset('asset-1')).toEqual(asset())
    expect(index.getCreditSnapshot()).toEqual(credits())
    now = 200
    expect(index.getAsset('asset-1')).toBeUndefined()
    expect(index.getCreditSnapshot()).toBeUndefined()
    expect(index.listAssetsByKind('image').map((entry) => entry.id)).toEqual(['permanent', 'later'])
    expect(index.pruneExpired()).toBe(2)
    expect(index.pruneExpired()).toBe(0)
    expect(index.toJSON().creditSnapshot).toBeNull()
    expect(index.pruneExpired(201)).toBe(1)
    expect(index.getAsset('permanent')).toBeDefined()
  })

  it('allows refreshing an expired asset', () => {
    const index = new OmniRogueLocalCacheIndex(() => 200)
    index.upsertAsset(asset())
    index.upsertAsset(asset({ cachedAt: 200, expiresAt: 300 }))
    expect(index.getAsset('asset-1')?.expiresAt).toBe(300)
    expect(index.pruneExpired()).toBe(0)
  })

  it('replaces credit snapshots and isolates their nested balances', () => {
    const index = new OmniRogueLocalCacheIndex(() => 150)
    const snapshot = credits()
    index.setCreditSnapshot(snapshot)
    snapshot.balance.availableCredits = 0
    index.getCreditSnapshot()!.balance.availableCredits = 1
    index.toJSON().creditSnapshot!.balance.availableCredits = 2
    expect(index.getCreditSnapshot()).toEqual(credits())
    index.setCreditSnapshot(snapshot)
    expect(index.getCreditSnapshot()?.balance.availableCredits).toBe(0)
  })

  it('round trips objects and JSON text without sharing references or reviving expired entries', () => {
    const index = new OmniRogueLocalCacheIndex(() => 150)
    index.upsertAsset(asset())
    index.upsertAsset(asset({ id: '__proto__', expiresAt: undefined }))
    index.setCreditSnapshot(credits())
    const json = index.toJSON()
    const restored = OmniRogueLocalCacheIndex.fromJSON(json, () => 150)
    const fromString = OmniRogueLocalCacheIndex.fromJSON(JSON.stringify(index), () => 200)
    expect(restored.toJSON()).toEqual(json)
    expect(fromString.toJSON()).toEqual(json)
    expect(fromString.getAsset('asset-1')).toBeUndefined()
    expect(fromString.getCreditSnapshot()).toBeUndefined()
    expect(fromString.getAsset('__proto__')).toBeDefined()
    json.assets[0].localPath = 'changed-json'
    json.creditSnapshot!.balance.availableCredits = 0
    expect(restored.getAsset('asset-1')).toEqual(asset())
    expect(restored.getCreditSnapshot()).toEqual(credits())
  })

  it('round trips an empty cache', () => {
    const index = new OmniRogueLocalCacheIndex()
    expect(OmniRogueLocalCacheIndex.fromJSON(JSON.stringify(index)).toJSON()).toEqual(
      index.toJSON()
    )
  })

  it.each([
    null,
    [],
    {},
    { version: 2, assets: [], creditSnapshot: null },
    { version: 1, assets: {}, creditSnapshot: null },
    { version: 1, assets: [] },
    { version: 1, assets: [], creditSnapshot: [] }
  ])('rejects malformed indexes: %j', (value) => {
    expect(() => OmniRogueLocalCacheIndex.fromJSON(value)).toThrow(TypeError)
  })

  it('rejects invalid JSON text', () => {
    expect(() => OmniRogueLocalCacheIndex.fromJSON('{')).toThrow(SyntaxError)
  })

  it.each([
    { id: '' },
    { localPath: ' ' },
    { kind: 'document' },
    { cachedAt: -1 },
    { expiresAt: Number.NaN },
    { expiresAt: Number.POSITIVE_INFINITY },
    { expiresAt: null }
  ])('rejects invalid asset fields without replacing valid data: %j', (invalid) => {
    const index = new OmniRogueLocalCacheIndex(() => 150)
    index.upsertAsset(asset())
    const entry = { ...asset(), ...invalid } as OmniRogueCachedAssetEntry
    expect(() => index.upsertAsset(entry)).toThrow(TypeError)
    expect(index.getAsset('asset-1')).toEqual(asset())
    expect(() =>
      OmniRogueLocalCacheIndex.fromJSON({
        version: 1,
        assets: [entry],
        creditSnapshot: null
      })
    ).toThrow(TypeError)
  })

  it.each([
    { availableCredits: -1 },
    { availableCredits: Number.NaN },
    { reservedCredits: -1 },
    { totalCredits: Number.POSITIVE_INFINITY },
    { lowBalanceThreshold: -1 },
    { updatedAt: '' },
    { plan: 42 },
    { currency: null }
  ])('rejects invalid credit balances without replacing valid data: %j', (invalid) => {
    const index = new OmniRogueLocalCacheIndex(() => 150)
    index.setCreditSnapshot(credits())
    const snapshot = {
      ...credits(),
      balance: { ...credits().balance, ...invalid }
    } as OmniRogueCachedCreditSnapshot
    expect(() => index.setCreditSnapshot(snapshot)).toThrow(TypeError)
    expect(index.getCreditSnapshot()).toEqual(credits())
    expect(() =>
      OmniRogueLocalCacheIndex.fromJSON({
        version: 1,
        assets: [],
        creditSnapshot: snapshot
      })
    ).toThrow(TypeError)
  })

  it('rejects invalid pruning timestamps without removing entries', () => {
    const index = new OmniRogueLocalCacheIndex(() => 150)
    index.upsertAsset(asset())
    expect(() => index.pruneExpired(Number.NaN)).toThrow(TypeError)
    expect(index.getAsset('asset-1')).toEqual(asset())
  })
})
