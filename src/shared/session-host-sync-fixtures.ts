/**
 * Steward (`t`) sync documents for mixed-version tests: one entry of every kind, an entry of a kind
 * no build knows yet, and a document a future version wrote.
 */

import { sessionHostSyncEntryId, type SessionHostSyncEntry } from './session-host-sync-doc'
import { FIXTURE_CONVERSATION_ID, FIXTURE_HOST, FIXTURE_NOW } from './session-host-wire-fixtures'

export const FIXTURE_SESSION_DIGEST = '5d41402abc4b2a76b9719d91'
export const FIXTURE_FOLDER_ID = '11111111-1111-4111-8111-111111111111'

export const FIXTURE_SYNC_ENTRIES: SessionHostSyncEntry[] = [
  {
    k: 'own',
    s: FIXTURE_SESSION_DIGEST,
    f: 'placement',
    r: 'org:12',
    v: FIXTURE_FOLDER_ID,
    op: 'op-own',
    h: FIXTURE_HOST.hostId,
    at: FIXTURE_NOW
  },
  {
    k: 'rev',
    s: FIXTURE_SESSION_DIGEST,
    f: 'title',
    op: 'op-rev',
    why: 'person/sidebar',
    at: FIXTURE_NOW + 1
  },
  { k: 'title', s: FIXTURE_SESSION_DIGEST, o: 'generated', r: 'org:13', at: FIXTURE_NOW + 2 },
  {
    k: 'pol',
    d: FIXTURE_FOLDER_ID,
    p: { automation: 'off', safeYesPerDay: 1 },
    at: FIXTURE_NOW + 3
  },
  {
    k: 'hist',
    s: FIXTURE_SESSION_DIGEST,
    op: 'op-hist',
    ch: 'archive',
    by: 'app',
    h: FIXTURE_HOST.hostId,
    at: FIXTURE_NOW + 4,
    sum: 'Archived: finished'
  },
  {
    k: 'res',
    s: FIXTURE_SESSION_DIGEST,
    ref: 'results/abc.json',
    h: FIXTURE_HOST.hostId,
    at: FIXTURE_NOW + 5
  },
  {
    k: 'alias',
    s: FIXTURE_SESSION_DIGEST,
    c: FIXTURE_CONVERSATION_ID,
    h: FIXTURE_HOST.hostId,
    at: FIXTURE_NOW + 6
  },
  {
    k: 'int',
    s: FIXTURE_SESSION_DIGEST,
    op: 'op-int',
    ch: 'move',
    v: FIXTURE_FOLDER_ID,
    at: FIXTURE_NOW + 7
  }
]

/** A kind a later build adds; every build before it must carry it untouched. */
export const FIXTURE_FUTURE_ENTRY = {
  k: 'lease',
  s: FIXTURE_SESSION_DIGEST,
  until: FIXTURE_NOW + 60_000,
  at: FIXTURE_NOW + 8
}
export const FIXTURE_FUTURE_ENTRY_ID = `lease:${FIXTURE_SESSION_DIGEST}`

export function fixtureStewardDocValue(): { v: 1; e: Record<string, unknown> } {
  const e: Record<string, unknown> = { [FIXTURE_FUTURE_ENTRY_ID]: FIXTURE_FUTURE_ENTRY }
  for (const entry of FIXTURE_SYNC_ENTRIES) {
    e[sessionHostSyncEntryId(entry)] = entry
  }
  return { v: 1, e }
}

/** What a future version of the `t` kind might write; this build must neither read nor replace it. */
export const FIXTURE_FUTURE_STEWARD_DOC = { v: 2, e: { anything: { k: 'own', shape: 'changed' } } }
