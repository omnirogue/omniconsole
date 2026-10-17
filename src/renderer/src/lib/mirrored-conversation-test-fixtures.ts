import type { AppState } from '@/store'
import {
  mirroredConversationBucketKey,
  type MirroredConversationBucket,
  type MirroredConversationOwner
} from '@/store/slices/mirrored-conversation-ledger'
import type { Repo } from '../../../shared/repo-types'
import {
  sessionConversationIdentity,
  sessionConversationPaneIdentity,
  type RuntimeSessionConversationRecord
} from '../../../shared/session-conversation-ledger'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { Worktree } from '../../../shared/worktree/types'
import {
  addSessionTestTab,
  SESSION_TEST_LEAF,
  SESSION_TEST_WORKTREE,
  sessionTestSource
} from './sidebar-session-test-fixtures'
import type { SidebarSessionSource } from './sidebar-sessions'

// Ledger fixtures for the receiver's sidebar rows (session parity, step 6).

export const LEDGER_ENV = 'env-studio'
export const LEDGER_T0 = 1_700_000_000_000
/** The owner's own tab and pane, as its ledger names them. */
export const OWNER_TAB = '9a3f0c11-5b7e-4c55-9d0e-1f2a3b4c5d6e'
export const OWNER_PANE = makePaneKey(OWNER_TAB, SESSION_TEST_LEAF)

/** A receiver whose test workspace is executed by the paired owner `environmentId`. */
export function pairedSource(environmentId = LEDGER_ENV): SidebarSessionSource {
  const source = sessionTestSource()
  source.repos = [
    { id: 'repo-a', displayName: 'Project A', executionHostId: `runtime:${environmentId}` } as Repo
  ]
  source.worktreesByRepo = {
    'repo-a': [
      {
        id: SESSION_TEST_WORKTREE,
        repoId: 'repo-a',
        displayName: 'main',
        hostId: `runtime:${environmentId}`
      } as Worktree
    ]
  }
  return source
}

/** The mirror tab this receiver holds for the owner's tab (legacy client id). */
export function addMirrorTab(
  source: SidebarSessionSource,
  ownerTabId = OWNER_TAB,
  /** null: a dormant tab whose frame names no agent (no row is built for it). */
  launchAgent: TerminalTab['launchAgent'] | null = 'claude'
): TerminalTab {
  const tab = addSessionTestTab(source, toWebTerminalSurfaceTabId(ownerTabId))
  tab.runtimeOwnerTabId = ownerTabId
  if (launchAgent) {
    tab.launchAgent = launchAgent
  } else {
    delete tab.launchAgent
  }
  return tab
}

export function providerSession(id: string) {
  return { key: 'session_id' as const, id }
}

/** The digest an owner sends for (worktree, agent, provider session). */
export function conversationDigest(
  id: string,
  agent = 'claude',
  worktreeId = SESSION_TEST_WORKTREE,
  transcriptPath?: string
): string {
  return sessionConversationIdentity({
    worktreeId,
    agent,
    providerSession: { ...providerSession(id), ...(transcriptPath ? { transcriptPath } : {}) }
  })!
}

/** A listed record for one provider conversation; a tab record when `paneKey` is given. */
export function ledgerRecord(
  id: string,
  overrides: Partial<RuntimeSessionConversationRecord> = {}
): RuntimeSessionConversationRecord {
  const paneKey = overrides.paneKey
  return {
    conversation: conversationDigest(id, overrides.agent ?? 'claude'),
    ...(paneKey ? { paneIdentity: sessionConversationPaneIdentity(paneKey) } : {}),
    agent: 'claude',
    providerSession: providerSession(id),
    title: `Owner ${id}`,
    titleSource: 'custom',
    surface: paneKey ? 'tab' : 'record',
    ...(paneKey ? { tabId: paneKey.split(':')[0] } : {}),
    rest: paneKey ? 'live' : 'asleep',
    listed: true,
    updatedAt: 1,
    ...overrides
  }
}

/** A provider-less dormant pane, known to the owner by its pane only (F21 `p:`). */
export function paneRecord(ownerPaneKey: string): RuntimeSessionConversationRecord {
  return {
    conversation: null,
    paneIdentity: sessionConversationPaneIdentity(ownerPaneKey),
    agent: 'codex',
    providerSession: null,
    title: 'Shell',
    titleSource: 'terminal',
    surface: 'tab',
    paneKey: ownerPaneKey,
    tabId: ownerPaneKey.split(':')[0],
    rest: 'dormant',
    listed: true,
    updatedAt: 1
  }
}

export function ledgerBucket(
  records: RuntimeSessionConversationRecord[],
  overrides: Partial<MirroredConversationBucket> = {}
): MirroredConversationBucket {
  return {
    environmentId: LEDGER_ENV,
    worktreeId: SESSION_TEST_WORKTREE,
    records,
    coverage: { complete: true },
    source: 'window',
    generation: 'gen-1',
    revision: 1,
    listedAt: LEDGER_T0,
    ownerState: 'ready',
    asOf: LEDGER_T0,
    ...overrides
  }
}

export function ledgerOwner(
  overrides: Partial<MirroredConversationOwner> = {}
): MirroredConversationOwner {
  return {
    environmentId: LEDGER_ENV,
    state: 'ready',
    asOf: LEDGER_T0,
    generation: 'gen-1',
    revision: 1,
    source: 'window',
    listedAt: LEDGER_T0,
    folders: [],
    projects: [],
    omitted: { unknownHost: 0, unverified: 0 },
    removals: [],
    ...overrides
  }
}

/** The ledger slices as the receiver holds them: buckets by owner workspace, one owner entry each. */
export function ledgerSlices(
  buckets: MirroredConversationBucket[],
  owners: MirroredConversationOwner[] = [ledgerOwner()]
): Pick<AppState, 'mirroredConversationLedgerByOwner' | 'mirroredConversationOwnersByEnvironment'> {
  return {
    mirroredConversationLedgerByOwner: Object.fromEntries(
      buckets.map((bucket) => [
        mirroredConversationBucketKey(bucket.environmentId, bucket.worktreeId),
        bucket
      ])
    ),
    mirroredConversationOwnersByEnvironment: Object.fromEntries(
      owners.map((owner) => [owner.environmentId, owner])
    )
  }
}
