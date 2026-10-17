import { afterEach, describe, expect, it } from 'vitest'
import type {
  RuntimeSessionConversationRecord,
  SessionConversationLedgerWindowPublication
} from '../../../shared/session-conversation-ledger'
import {
  _resetPublishedConversationLedgerForTests,
  publishedConversationLedgerRest,
  rememberPublishedConversationLedger
} from './session-conversation-ledger-latest'

const WT = 'repo::/project-a'
const DIGEST = 'a1b2c3d4e5f60718293a4b5c'
const PANE = 'tab-1:00000000-0000-4000-8000-000000000001'

function record(
  overrides: Partial<RuntimeSessionConversationRecord>
): RuntimeSessionConversationRecord {
  return {
    conversation: DIGEST,
    agent: 'claude',
    providerSession: { key: 'session_id', id: 's1' },
    title: 'Ads',
    titleSource: 'custom',
    surface: 'tab',
    rest: 'live',
    listed: true,
    updatedAt: 1,
    ...overrides
  }
}

function publication(
  records: RuntimeSessionConversationRecord[]
): SessionConversationLedgerWindowPublication {
  return {
    rendererGeneration: 'renderer-1',
    listedAt: 1,
    coverage: [{ worktreeId: WT, complete: true }],
    omitted: { unknownHost: 0, unverified: 0 },
    folders: [],
    projects: [],
    recordsByWorktree: { [WT]: records }
  }
}

afterEach(() => _resetPublishedConversationLedgerForTests())

describe("this window's last published ledger (session parity, step 8)", () => {
  it('knows no rest before this window published anything', () => {
    expect(publishedConversationLedgerRest(WT, `c:${DIGEST}`)).toBeUndefined()
  })

  it('reads the rest each listed record carried, by workspace and tagged identity', () => {
    rememberPublishedConversationLedger(
      publication([
        record({ paneIdentity: `pane:${PANE}`, paneKey: PANE }),
        record({
          conversation: null,
          paneIdentity: 'pane:tab-2:leaf',
          providerSession: null,
          rest: 'dormant'
        }),
        record({ conversation: 'ffeeddccbbaa998877665544', listed: false, rest: 'asleep' })
      ])
    )
    expect(publishedConversationLedgerRest(WT, `c:${DIGEST}`)).toBe('live')
    expect(publishedConversationLedgerRest(WT, 'p:pane:tab-2:leaf')).toBe('dormant')
    // Passive evidence is no row of the owner's list, and another workspace is another bucket.
    expect(publishedConversationLedgerRest(WT, 'c:ffeeddccbbaa998877665544')).toBeUndefined()
    expect(publishedConversationLedgerRest('repo::/other', `c:${DIGEST}`)).toBeUndefined()

    rememberPublishedConversationLedger(publication([record({ rest: 'asleep' })]))
    expect(publishedConversationLedgerRest(WT, `c:${DIGEST}`)).toBe('asleep')
  })
})
