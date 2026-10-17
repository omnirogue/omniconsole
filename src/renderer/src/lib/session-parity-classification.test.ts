import { describe, expect, it } from 'vitest'
import { providerSessionFolderKey } from '../../../shared/session-folder-identity'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { MirroredSidebarConversation } from './mirrored-conversation-row-types'
import {
  conversationDigest,
  LEDGER_ENV,
  ledgerBucket,
  ledgerOwner,
  OWNER_PANE,
  providerSession
} from './mirrored-conversation-test-fixtures'
import {
  classifySessionParity,
  sessionParityRowOf,
  type SessionParityInputs
} from './session-parity-classification'
import { SESSION_TEST_LEAF, SESSION_TEST_WORKTREE } from './sidebar-session-test-fixtures'
import type { SidebarSession } from './sidebar-sessions'

const W = SESSION_TEST_WORKTREE
const PEER = `runtime:${LEDGER_ENV}` as const
const LOCAL_PANE = makePaneKey('9d1c4c3e-6035-41cd-a874-7d9d1341abb2', SESSION_TEST_LEAF)

function row(overrides: Partial<SidebarSession>): SidebarSession {
  return {
    rowKey: 'row',
    sessionKey: null,
    worktreeId: W,
    hostId: 'local',
    tabId: 'tab',
    paneKey: LOCAL_PANE,
    kind: 'terminal',
    label: 'Session',
    workspaceLabel: 'Work',
    agent: 'claude',
    unavailable: false,
    folderKeyMigration: null,
    ...overrides
  }
}

function claimKey(hostId: SidebarSession['hostId'], id: string): string {
  return providerSessionFolderKey({
    hostId: hostId ?? 'local',
    worktreeId: W,
    agent: 'claude',
    providerSession: providerSession(id)
  })
}

function vouched(
  overrides: Partial<MirroredSidebarConversation> = {}
): MirroredSidebarConversation {
  return {
    environmentId: LEDGER_ENV,
    conversation: conversationDigest('s1'),
    ownerPaneKey: null,
    ownerTabId: null,
    rest: 'asleep',
    listed: true,
    stale: false,
    ownerState: 'ready',
    ...overrides
  }
}

function inputs(overrides: Partial<SessionParityInputs> = {}): SessionParityInputs {
  return {
    eligibility: { published: new Set(), quarantined: new Map() },
    owners: { [LEDGER_ENV]: ledgerOwner() },
    ledgerBuckets: {},
    workflowBuckets: {},
    unverifiedReason: () => null,
    ownerPaneKey: () => null,
    publishedRest: () => undefined,
    ...overrides
  }
}

describe('classifySessionParity (session parity, step 8)', () => {
  it("files a row its owner's ledger lists as ownerListed, with the owner's identity and rest", () => {
    const fields = classifySessionParity(
      row({ hostId: PEER, tabId: null, paneKey: null, mirroredConversation: vouched() }),
      inputs()
    )
    expect(fields).toEqual({
      bucket: 'ownerListed',
      verification: 'verified',
      identity: `c:${conversationDigest('s1')}`,
      conversation: conversationDigest('s1'),
      rest: 'asleep'
    })
  })

  it("counts a launch still in flight under `local` as this computer's own, other quarantines apart", () => {
    const launching = row({
      rowKey: 'launching',
      sessionKey: null,
      tabId: 'tab-launch',
      paneKey: null,
      launchPending: true
    })
    const quarantined = (reason: 'no-identity' | 'unknown-host' | 'peer-provenance') =>
      inputs({
        eligibility: { published: new Set(), quarantined: new Map([['launching', reason]]) }
      })
    expect(classifySessionParity(launching, quarantined('no-identity'))).toEqual({
      bucket: 'ownerListed',
      verification: 'verified',
      identity: null,
      conversation: null
    })
    expect(classifySessionParity(launching, quarantined('peer-provenance'))).toMatchObject({
      bucket: 'receiverOnly',
      verification: 'unverified',
      bucketReason: 'peer-provenance'
    })
    // A row under no host at all may be a paired computer's: never this one's own.
    expect(
      classifySessionParity({ ...launching, hostId: null }, quarantined('no-identity'))
    ).toMatchObject({ bucket: 'receiverOnly', verification: 'unverified' })
  })

  it('names a provider-less owner pane by its pane identity (F21 p:), never skipping it', () => {
    const fields = classifySessionParity(
      row({
        hostId: PEER,
        mirroredConversation: vouched({ conversation: null, paneIdentity: `pane:${OWNER_PANE}` })
      }),
      inputs()
    )
    expect(fields).toMatchObject({
      bucket: 'ownerListed',
      identity: `p:pane:${OWNER_PANE}`,
      conversation: null,
      paneIdentity: `pane:${OWNER_PANE}`
    })
  })

  it('files a capture an owner holds without listing as heldByOwner (G1), verified', () => {
    expect(
      classifySessionParity(
        row({ hostId: PEER, tabId: null, mirroredConversation: vouched({ listed: false }) }),
        inputs()
      )
    ).toMatchObject({ bucket: 'heldByOwner', verification: 'verified' })
  })

  it('flags restored, unreachable, older and history-gap owner rows by how current they are', () => {
    const verdict = (conversation: MirroredSidebarConversation) =>
      classifySessionParity(row({ hostId: PEER, mirroredConversation: conversation }), inputs())
    expect(verdict(vouched({ stale: true, ownerState: 'stale' }))).toMatchObject({
      bucket: 'ownerListed',
      verification: 'stale',
      stale: true
    })
    expect(verdict(vouched({ ownerState: 'unreachable' }))).toMatchObject({
      verification: 'stale'
    })
    expect(verdict(vouched({ ownerState: 'older' }))).toMatchObject({
      verification: 'unverified',
      bucketReason: 'owner-older'
    })
    expect(
      verdict(vouched({ unverified: 'disconnected-longer-than-deletion-history' }))
    ).toMatchObject({
      verification: 'unverified',
      bucketReason: 'disconnected-longer-than-deletion-history'
    })
  })

  it("files a paired row no ledger record names as receiverOnly that can't be verified", () => {
    const capture = row({
      hostId: PEER,
      tabId: null,
      sessionKey: claimKey(PEER, 'other')
    })
    expect(
      classifySessionParity(capture, inputs({ unverifiedReason: () => 'absence-unverified' }))
    ).toEqual({
      bucket: 'receiverOnly',
      verification: 'unverified',
      // Why the same digest as the owner's: a mirrored workspace keeps the owner's worktree id (F1).
      identity: `c:${conversationDigest('other')}`,
      conversation: conversationDigest('other'),
      paneIdentity: `pane:${LOCAL_PANE}`,
      bucketReason: 'absence-unverified'
    })
    const incomplete = inputs({
      ledgerBuckets: {
        [JSON.stringify([LEDGER_ENV, W])]: ledgerBucket([], { coverage: { complete: false } })
      }
    })
    expect(classifySessionParity(row({ hostId: PEER }), incomplete)).toMatchObject({
      bucket: 'receiverOnly',
      verification: 'unverified',
      bucketReason: 'owner-ledger-incomplete'
    })
    expect(classifySessionParity(row({ hostId: PEER }), inputs())).toMatchObject({
      bucketReason: 'not-in-owner-ledger'
    })
  })

  it('keeps an older owner’s live mirror rows verified by its frames; only captures are doubted', () => {
    const older = inputs({ owners: { [LEDGER_ENV]: ledgerOwner({ state: 'older' }) } })
    expect(
      classifySessionParity(row({ hostId: PEER }), { ...older, ownerPaneKey: () => OWNER_PANE })
    ).toEqual({
      bucket: 'receiverOnly',
      verification: 'verified',
      identity: `p:pane:${OWNER_PANE}`,
      conversation: null,
      paneIdentity: `pane:${OWNER_PANE}`
    })
    expect(
      classifySessionParity(row({ hostId: PEER, tabId: null }), {
        ...older,
        unverifiedReason: () => 'absence-unverified'
      })
    ).toMatchObject({ verification: 'unverified', bucketReason: 'absence-unverified' })
    // No ledger was ever heard from this owner at all: the same.
    expect(classifySessionParity(row({ hostId: PEER }), inputs({ owners: {} }))).toMatchObject({
      bucket: 'receiverOnly',
      verification: 'verified'
    })
  })

  it("reads this computer's own rows by its ledger's eligibility rule (F7)", () => {
    const published = row({ rowKey: 'own', sessionKey: claimKey('local', 's1') })
    const quarantined = row({ rowKey: 'peerish' })
    const rule = inputs({
      eligibility: {
        published: new Set(['own']),
        quarantined: new Map([['peerish', 'peer-provenance']])
      },
      publishedRest: (worktreeId, identity) =>
        worktreeId === W && identity === `c:${conversationDigest('s1')}` ? 'live' : undefined
    })
    expect(classifySessionParity(published, rule)).toEqual({
      bucket: 'ownerListed',
      verification: 'verified',
      identity: `c:${conversationDigest('s1')}`,
      conversation: conversationDigest('s1'),
      paneIdentity: `pane:${LOCAL_PANE}`,
      rest: 'live'
    })
    expect(classifySessionParity(quarantined, rule)).toEqual({
      bucket: 'receiverOnly',
      verification: 'unverified',
      identity: `p:pane:${LOCAL_PANE}`,
      conversation: null,
      paneIdentity: `pane:${LOCAL_PANE}`,
      bucketReason: 'peer-provenance'
    })
  })

  it("lists this computer's SSH rows and chats as its own; a row with no host never", () => {
    expect(classifySessionParity(row({ hostId: 'ssh:box' }), inputs())).toMatchObject({
      bucket: 'ownerListed',
      verification: 'verified'
    })
    expect(
      classifySessionParity(row({ kind: 'structured', paneKey: null }), inputs())
    ).toMatchObject({ bucket: 'ownerListed', identity: null })
    expect(classifySessionParity(row({ hostId: null }), inputs())).toMatchObject({
      bucket: 'receiverOnly',
      verification: 'unverified',
      bucketReason: 'unknown-host'
    })
  })

  it('reports workflows apart, by their anchor tab on either computer (w:)', () => {
    const own = row({
      tabId: 'flow-tab',
      paneKey: null,
      workflow: { preset: 'council', status: 'running' }
    })
    expect(classifySessionParity(own, inputs())).toEqual({
      bucket: 'workflow',
      verification: 'verified',
      identity: 'w:flow-tab',
      conversation: null
    })
    const mirrored = row({
      hostId: PEER,
      tabId: null,
      paneKey: null,
      workflow: { preset: 'council', status: 'running' },
      mirroredWorkflow: {
        environmentId: LEDGER_ENV,
        hostTabId: 'owner-flow-tab',
        runId: null,
        archivedByOwner: false
      }
    })
    const restored = inputs({
      workflowBuckets: {
        [JSON.stringify([LEDGER_ENV, W])]: {
          environmentId: LEDGER_ENV,
          worktreeId: W,
          records: [],
          stale: true
        }
      }
    })
    expect(classifySessionParity(mirrored, restored)).toEqual({
      bucket: 'workflow',
      verification: 'stale',
      identity: 'w:owner-flow-tab',
      conversation: null,
      stale: true
    })
  })

  it('makes one population row under the host the sidebar counts it under', () => {
    const flow = row({ hostId: 'ssh:box', displayHostId: 'local', label: 'Council' })
    expect(sessionParityRowOf(flow, classifySessionParity(flow, inputs()), true)).toEqual({
      hostId: 'local',
      worktreeId: W,
      kind: 'terminal',
      agent: 'claude',
      archived: true,
      label: 'Council',
      bucket: 'ownerListed',
      verification: 'verified',
      identity: `p:pane:${LOCAL_PANE}`,
      conversation: null,
      paneIdentity: `pane:${LOCAL_PANE}`
    })
    const hostless = row({ hostId: null })
    expect(
      sessionParityRowOf(hostless, classifySessionParity(hostless, inputs()), false).hostId
    ).toBe('unknown')
  })
})
