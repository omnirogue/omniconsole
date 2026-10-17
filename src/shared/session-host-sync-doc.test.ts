import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_SYNC_KEY,
  ACCOUNT_SYNC_VALUE_MAX_BYTES,
  accountSyncValueSize
} from './account-sync-types'
import {
  SESSION_HOST_SYNC_ENTRY_KINDS,
  SESSION_HOST_SYNC_HISTORY_PER_SESSION,
  boundSessionHostSyncHistory,
  effectiveSessionHostFolderPolicy,
  layoutSessionHostSyncDocs,
  mayRewriteSessionHostSyncDoc,
  mergeSessionHostSyncDocs,
  parseSessionHostSyncDoc,
  parseSessionHostSyncDocKey,
  sessionHostSyncDocKey,
  sessionHostSyncDocValue,
  sessionHostSyncEntryId,
  type SessionHostSyncDoc,
  type SessionHostSyncEntry
} from './session-host-sync-doc'
import {
  FIXTURE_FUTURE_ENTRY,
  FIXTURE_FUTURE_ENTRY_ID,
  FIXTURE_FUTURE_STEWARD_DOC,
  FIXTURE_SESSION_DIGEST,
  FIXTURE_SYNC_ENTRIES,
  fixtureStewardDocValue
} from './session-host-sync-fixtures'
import { sessionHostDigest } from './session-host-identity'
import { FIXTURE_NOW } from './session-host-wire-fixtures'

/** Pinned: the device-document key every released client parses (session-sync-keys.ts). */
const RELEASED_DEVICE_DOC = /^omni-ide\.sync\.d\.([0-9a-f]{8})\.([fs])\.(\d{1,3})$/
const wire = <T>(value: T): unknown => JSON.parse(JSON.stringify(value))
const read = (value: unknown): SessionHostSyncDoc => {
  const parsed = parseSessionHostSyncDoc(value)
  if (parsed.status !== 'read') {
    throw new Error(`expected a readable document, got ${parsed.status}`)
  }
  return parsed.doc
}
const hist = (s: string, n: number): SessionHostSyncEntry => ({
  k: 'hist',
  s,
  op: `op-${n}`,
  ch: 'move',
  by: 'pane',
  at: FIXTURE_NOW + n
})

describe('steward sync document keys', () => {
  it('is a valid account-sync key that released clients never parse as theirs', () => {
    const key = sessionHostSyncDocKey('0badf00d', 3)
    expect(key).toBe('omni-ide.sync.d.0badf00d.t.3')
    expect(ACCOUNT_SYNC_KEY.test(key)).toBe(true)
    expect(RELEASED_DEVICE_DOC.test(key)).toBe(false)
    expect(parseSessionHostSyncDocKey(key)).toEqual({ device: '0badf00d', index: 3 })
    for (const other of [
      'omni-ide.sync.d.0badf00d.f.0',
      'omni-ide.sync.d.0badf00d.s.1',
      'omni-ide.sync.d.0badf00d.t.256'
    ]) {
      expect(parseSessionHostSyncDocKey(other)).toBeNull()
    }
    expect(() => sessionHostSyncDocKey('XYZ', 0)).toThrow()
  })
})

describe('steward sync documents', () => {
  it('covers every entry kind in the fixtures', () => {
    expect(new Set(FIXTURE_SYNC_ENTRIES.map((entry) => entry.k))).toEqual(
      new Set(SESSION_HOST_SYNC_ENTRY_KINDS)
    )
  })

  it('round-trips every kind, and carries a kind it does not know byte for byte', () => {
    const doc = read(wire(fixtureStewardDocValue()))
    expect(Object.values(doc.entries)).toEqual(expect.arrayContaining(FIXTURE_SYNC_ENTRIES))
    expect(doc.opaque).toEqual({ [FIXTURE_FUTURE_ENTRY_ID]: FIXTURE_FUTURE_ENTRY })
    expect(wire(sessionHostSyncDocValue(doc))).toEqual(fixtureStewardDocValue())
  })

  it('keeps a newer build’s extra field on a known entry through this build’s rewrite', () => {
    const value = fixtureStewardDocValue()
    const id = sessionHostSyncEntryId(FIXTURE_SYNC_ENTRIES[0]!)
    value.e[id] = { ...(value.e[id] as object), lease: 'x' }
    expect(wire(sessionHostSyncDocValue(read(wire(value))))).toEqual(value)
  })

  it('drops malformed known entries and entries filed under the wrong id', () => {
    const value = {
      v: 1,
      e: {
        'own:bad': FIXTURE_SYNC_ENTRIES[0],
        [sessionHostSyncEntryId(FIXTURE_SYNC_ENTRIES[1]!)]: {
          ...FIXTURE_SYNC_ENTRIES[1],
          f: 'color'
        },
        noKind: { s: FIXTURE_SESSION_DIGEST }
      }
    }
    expect(read(value)).toEqual({ entries: {}, opaque: {} })
  })

  it('never reads or replaces a document a newer version wrote', () => {
    expect(parseSessionHostSyncDoc(FIXTURE_FUTURE_STEWARD_DOC)).toEqual({
      status: 'newer',
      version: 2
    })
    expect(mayRewriteSessionHostSyncDoc(FIXTURE_FUTURE_STEWARD_DOC)).toBe(false)
    expect(mayRewriteSessionHostSyncDoc(undefined)).toBe(true)
    expect(mayRewriteSessionHostSyncDoc(fixtureStewardDocValue())).toBe(true)
    expect(parseSessionHostSyncDoc({ f: {} }).status).toBe('unreadable')
  })

  it('merges by id: later wins, ties resolve the same on every computer', () => {
    const own = FIXTURE_SYNC_ENTRIES[0]!
    const id = sessionHostSyncEntryId(own)
    const later = { ...own, v: null, at: own.at + 1 } as SessionHostSyncEntry
    const tie = { ...own, v: null } as SessionHostSyncEntry
    const a: SessionHostSyncDoc = { entries: { [id]: own }, opaque: {} }
    expect(
      mergeSessionHostSyncDocs(a, { entries: { [id]: later }, opaque: {} }).entries[id]
    ).toEqual(later)
    const ab = mergeSessionHostSyncDocs(a, { entries: { [id]: tie }, opaque: {} })
    const ba = mergeSessionHostSyncDocs({ entries: { [id]: tie }, opaque: {} }, a)
    expect(ab.entries[id]).toEqual(ba.entries[id])
  })

  it('merges history by operation id and bounds it without losing a revocation', () => {
    const rows = Array.from({ length: SESSION_HOST_SYNC_HISTORY_PER_SESSION + 5 }, (_, n) =>
      hist(FIXTURE_SESSION_DIGEST, n)
    )
    const left = Object.fromEntries(
      rows.slice(0, 15).map((row) => [sessionHostSyncEntryId(row), row])
    )
    const right = Object.fromEntries(
      rows.slice(10).map((row) => [sessionHostSyncEntryId(row), row])
    )
    const revocation = FIXTURE_SYNC_ENTRIES[1]!
    const merged = mergeSessionHostSyncDocs(
      { entries: { ...left, [sessionHostSyncEntryId(revocation)]: revocation }, opaque: {} },
      { entries: right, opaque: {} }
    )
    expect(Object.values(merged.entries).filter((entry) => entry.k === 'hist')).toHaveLength(
      rows.length
    )
    const bounded = boundSessionHostSyncHistory(merged)
    const kept = Object.values(bounded.entries).filter((entry) => entry.k === 'hist')
    expect(kept.map((entry) => entry.at).sort()).toEqual(rows.slice(5).map((row) => row.at))
    expect(bounded.entries[sessionHostSyncEntryId(revocation)]).toEqual(revocation)
  })

  it('drops a pending intent once the owner has recorded that operation, not before', () => {
    const intent: SessionHostSyncEntry = {
      k: 'int',
      s: FIXTURE_SESSION_DIGEST,
      op: 'op-9',
      ch: 'move',
      at: FIXTURE_NOW
    }
    const pending = { entries: { 'int:op-9': intent }, opaque: {} }
    expect(boundSessionHostSyncHistory(pending).entries['int:op-9']).toEqual(intent)
    const answered = {
      entries: {
        ...pending.entries,
        'hist:op-9': { ...hist(FIXTURE_SESSION_DIGEST, 9), op: 'op-9' }
      },
      opaque: {}
    }
    expect(boundSessionHostSyncHistory(answered).entries['int:op-9']).toBeUndefined()
  })

  it('turns automation off for a folder whose override names a restriction it does not know', () => {
    expect(effectiveSessionHostFolderPolicy({ safeYesPerDay: 1 })).toEqual({ safeYesPerDay: 1 })
    expect(effectiveSessionHostFolderPolicy({ safeYesPerDay: 1, noMerges: true })).toEqual({
      safeYesPerDay: 1,
      noMerges: true,
      automation: 'off',
      relocation: 'off'
    })
  })

  it('lays entries out in documents that each fit omnios, doubling as needed', () => {
    const many: SessionHostSyncDoc = {
      entries: {},
      opaque: { [FIXTURE_FUTURE_ENTRY_ID]: FIXTURE_FUTURE_ENTRY }
    }
    for (let n = 0; n < 1500; n += 1) {
      // Real session digests are SHA-256 prefixes, so they spread across documents.
      const s = sessionHostDigest(`session-${n}`).slice('sha256:'.length, 'sha256:'.length + 24)
      many.entries[`hist:op-${n}`] = { ...hist(s, n), sum: 'x'.repeat(100) }
    }
    const docs = layoutSessionHostSyncDocs(many)
    expect(docs.length).toBeGreaterThan(1)
    for (const doc of docs) {
      expect(accountSyncValueSize(sessionHostSyncDocValue(doc))).toBeLessThanOrEqual(
        ACCOUNT_SYNC_VALUE_MAX_BYTES
      )
    }
    const all = docs.reduce(mergeSessionHostSyncDocs, { entries: {}, opaque: {} })
    expect(all).toEqual(many)
  })
})
