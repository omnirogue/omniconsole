import { describe, expect, it } from 'vitest'
import {
  canonicalSessionKey,
  deviceDocKey,
  localKeyDigest,
  mayBecomeSyncable,
  parseDeviceDocKey,
  SESSION_SYNC_MAX_DOCS,
  syncDocIndex
} from './account-sync-session-keys'
import {
  collectRemote,
  foldersAhead,
  highestStamp,
  mergeFolders,
  mergeSessions,
  parseFolderDoc,
  parseSessionShard,
  sessionsAhead
} from './account-sync-session-docs'

const FOLDER = '11111111-1111-4111-8111-111111111111'
const D1 = 'aaaaaaaaaaaaaaaaaaaaaaaa'

describe('session sync keys', () => {
  it('names a session the same from every computer, and leaves provisional keys out', () => {
    const provider = (host: string) =>
      JSON.stringify([host, 'provider', 'repo::/app\0claude\0claude\0abc'])
    expect(canonicalSessionKey(provider('local'))).toBe(
      canonicalSessionKey(provider('runtime:bigmac'))
    )
    expect(localKeyDigest(provider('local'))).toMatch(/^[0-9a-f]{24}$/)
    expect(localKeyDigest(provider('local'))).toBe(localKeyDigest(provider('ssh:vm')))
    // An SSH project carries each client's own repo id; the path is what they share.
    const onClient = (repo: string) =>
      JSON.stringify(['ssh:mw0002', 'provider', `${repo}::/srv/app\0claude\0claude\0abc`])
    expect(localKeyDigest(onClient('repo-a'))).toBe(localKeyDigest(onClient('repo-b')))
    expect(localKeyDigest(onClient('repo-a'))).not.toBe(
      localKeyDigest(onClient('repo-a').replace('abc', 'xyz'))
    )
    // A folder workspace is its folder, whatever id each client gave it; unknown until loaded.
    const inFolder = (id: string) =>
      JSON.stringify(['ssh:mw0002', 'provider', `folder:${id}\0claude\0claude\0abc`])
    const paths = { 'id-on-laptop': '/srv/notes', 'id-on-bigmac': '/srv/notes' }
    expect(localKeyDigest(inFolder('id-on-laptop'), paths)).toBe(
      localKeyDigest(inFolder('id-on-bigmac'), paths)
    )
    expect(localKeyDigest(inFolder('id-on-laptop'), paths)).toBe(
      localKeyDigest(onClient('repo-a').replace('/srv/app', '/srv/notes'))
    )
    expect(localKeyDigest(inFolder('not-loaded'), paths)).toBeNull()
    expect(mayBecomeSyncable(inFolder('not-loaded'))).toBe(true)
    expect(mayBecomeSyncable(JSON.stringify(['local', 'pane', 'wt', 'tab:1']))).toBe(true)
    expect(mayBecomeSyncable(JSON.stringify(['local', 'routine', 'r1']))).toBe(false)
    expect(canonicalSessionKey(JSON.stringify(['local', 'structured', 'id-1']))).toBe(
      '["structured","id-1"]'
    )
    expect(canonicalSessionKey(JSON.stringify(['local', 'pane', 'wt', 'tab:1']))).toBeNull()
    expect(canonicalSessionKey(JSON.stringify(['local', 'tab-1']))).toBeNull()
    expect(canonicalSessionKey('not json')).toBeNull()
    const digest = localKeyDigest(provider('local'))!
    for (const count of [16, 32, 256]) {
      expect(syncDocIndex('sessions', digest, count)).toBeLessThan(count)
    }
    // Doubling splits a document in two: an entry stays or moves to its new twin.
    expect(syncDocIndex('sessions', digest, 32) % 16).toBe(syncDocIndex('sessions', digest, 16))
    expect(syncDocIndex('folders', FOLDER, 4) % 2).toBe(syncDocIndex('folders', FOLDER, 2))
    expect(parseDeviceDocKey(deviceDocKey('0a1b2c3d', 'sessions', 255))).toEqual({
      device: '0a1b2c3d',
      kind: 'sessions'
    })
    expect(parseDeviceDocKey(deviceDocKey('0a1b2c3d', 'folders', 0))).toEqual({
      device: '0a1b2c3d',
      kind: 'folders'
    })
    expect(parseDeviceDocKey(`omni-ide.sync.d.0a1b2c3d.s.${SESSION_SYNC_MAX_DOCS}`)).toBeNull()
    expect(parseDeviceDocKey('omni-ide.sync.folders')).toBeNull()
  })
})

describe('session sync documents', () => {
  it('keeps only well-formed entries from another computer', () => {
    expect(
      parseSessionShard({
        v: 1,
        s: {
          [D1]: { f: [FOLDER, 5], a: [null, 5] },
          nothex: { f: [FOLDER, 5] },
          bbbbbbbbbbbbbbbbbbbbbbbb: { f: ['../etc', 5] },
          cccccccccccccccccccccccc: { a: [3, -1] }
        }
      })
    ).toEqual({ [D1]: { f: [FOLDER, 5], a: [null, 5] } })
    expect(parseSessionShard({ v: 2, s: {} })).toEqual({})
    expect(
      parseFolderDoc({
        v: 1,
        f: {
          [FOLDER]: { n: 'Clients', t: 4, s: 'saved' },
          'not-a-folder': { n: 'x', t: 1 },
          '22222222-2222-4222-8222-222222222222': { n: '', t: 1 },
          // Ids the folder store refuses would stop every later sync on this computer.
          'saved-sessions': { n: 'Saved', t: 1 },
          '33333333-3333-4333-8333-333333333333': { n: 'Kid', t: 1, p: 'saved-sessions' }
        }
      })
    ).toEqual({ [FOLDER]: { n: 'Clients', t: 4, s: 'saved' } })
  })

  it('merges field by field: the later write wins, and on a tie a value beats none', () => {
    const merged = mergeSessions(
      { [D1]: { f: [FOLDER, 10], a: [null, 1] } },
      { [D1]: { f: [null, 5], a: [7, 8] } }
    )
    expect(merged).toEqual({ [D1]: { f: [FOLDER, 10], a: [7, 8] } })
    expect(mergeSessions({ [D1]: { f: [null, 5] } }, { [D1]: { f: [FOLDER, 5] } })).toEqual({
      [D1]: { f: [FOLDER, 5] }
    })
    const own = { n: 'Old', t: 3 }
    expect(mergeFolders({ [FOLDER]: own }, { [FOLDER]: { n: 'New', t: 4 } })[FOLDER]!.n).toBe('New')
    expect(mergeFolders({ [FOLDER]: own }, { [FOLDER]: { n: 'Older', t: 2 } })[FOLDER]).toBe(own)
  })

  it('says a document needs writing only when it is ahead', () => {
    const ours = { [D1]: { f: [FOLDER, 5] as [string, number] } }
    expect(sessionsAhead(ours, { [D1]: { f: [FOLDER, 5] } })).toBe(false)
    expect(sessionsAhead(ours, { [D1]: { f: [null, 4] } })).toBe(true)
    expect(sessionsAhead(ours, {})).toBe(true)
    expect(sessionsAhead(ours, { [D1]: { f: [null, 6] } })).toBe(false)
    expect(foldersAhead({ [FOLDER]: { n: 'A', t: 1 } }, { [FOLDER]: { n: 'A', t: 1 } })).toBe(false)
    expect(foldersAhead({ [FOLDER]: { n: 'A', t: 2 } }, { [FOLDER]: { n: 'A', t: 1 } })).toBe(true)
  })

  it('merges every computer’s documents and keeps this computer’s own copy apart', () => {
    const { all, stored } = collectRemote(
      {
        [deviceDocKey('0000000a', 'sessions', 1)]: { v: 1, s: { [D1]: { f: [FOLDER, 5] } } },
        [deviceDocKey('0000000b', 'sessions', 40)]: { v: 1, s: { [D1]: { a: [9, 7] } } },
        [deviceDocKey('0000000b', 'folders', 3)]: { v: 1, f: { [FOLDER]: { n: 'A', t: 8 } } },
        'omni-ide.sync.other': { v: 1 }
      },
      '0000000a'
    )
    expect(all.sessions).toEqual({ [D1]: { f: [FOLDER, 5], a: [9, 7] } })
    // This computer's own documents, each as omnios holds it.
    expect(stored).toEqual(
      new Map([
        [
          deviceDocKey('0000000a', 'sessions', 1),
          { sessions: { [D1]: { f: [FOLDER, 5] } }, folders: {} }
        ]
      ])
    )
    expect(highestStamp(all)).toBe(8)
  })
})
