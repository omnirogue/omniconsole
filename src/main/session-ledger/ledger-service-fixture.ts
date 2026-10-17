import { vi } from 'vitest'
import type { LedgerEventBatch } from '../../shared/session-ledger-contract'
import type { SessionLedgerClient } from './ledger-client'
import type { LedgerSendResult, LedgerSpillStore } from './ledger-event-queue'
import type { GitRead } from './ledger-commit-observer'
import type { LedgerPaneStore } from './ledger-identity'
import { SessionLedgerService, type LedgerHookStatus } from './ledger-service'

export const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'
export type GitIdentity = { repo: string | null; branch: string | null }

export function memoryPaneStore(): LedgerPaneStore {
  let persisted: ReturnType<LedgerPaneStore['load']> = []
  return {
    load: () => persisted,
    save: (entries) => {
      persisted = entries
    }
  }
}

export function ledgerServiceHarness(
  options: {
    sendResult?: LedgerSendResult
    hang?: boolean
    account?: string | null
    paneStore?: LedgerPaneStore
    readGit?: GitRead
    resolveGitIdentity?: () => Promise<GitIdentity>
    start?: boolean
  } = {}
) {
  const sent: LedgerEventBatch[] = []
  const sentAccounts: string[] = []
  const registered: [string, unknown, string][] = []
  const account = {
    current: (options.account === undefined ? 'principal-a' : options.account) as string | null
  }
  let hookListener: ((status: LedgerHookStatus) => void) | null = null
  let teardownListener: ((paneKey: string) => void) | null = null
  const spill: LedgerSpillStore & { value: unknown } = {
    value: null,
    read: () => spill.value,
    write: (value) => {
      spill.value = value
    },
    remove: () => {
      spill.value = null
    },
    quarantine: () => {
      spill.value = null
    }
  }
  const client: SessionLedgerClient = {
    events: vi.fn(async (batch: LedgerEventBatch, boundTo: string): Promise<LedgerSendResult> => {
      sent.push(structuredClone(batch))
      sentAccounts.push(boundTo)
      if (options.hang) {
        return new Promise<LedgerSendResult>(() => {})
      }
      return options.sendResult ?? { ok: true }
    }),
    now: vi.fn(async () => ({ ok: true as const, rows: [], overflow: 0, server_time: 't' })),
    peers: vi.fn(async () => ({ ok: true as const, peers: [] })),
    register: vi.fn(async (ledgerId: string, body: unknown, boundTo: string) => {
      registered.push([ledgerId, body, boundTo])
      return { ok: true as const }
    })
  }
  const service = new SessionLedgerService({
    client,
    host: () => 'test-host',
    principal: () => account.current,
    subscribeHookStatus: (listener) => {
      hookListener = listener
      return () => {
        hookListener = null
      }
    },
    subscribePaneTeardown: (listener) => {
      teardownListener = listener
      return () => {
        teardownListener = null
      }
    },
    resolveGitIdentity:
      options.resolveGitIdentity ??
      (async () => ({ repo: 'github.com/Org/Repo', branch: 'feat/x' })),
    readGit: options.readGit,
    paneStore: options.paneStore ?? null,
    spillStore: spill,
    mutedRepos: { read: () => [], set: () => [] },
    warn: vi.fn()
  })
  if (options.start !== false) {
    service.start({ userDataPath: '/unused' })
  }
  const hook = (status: Partial<LedgerHookStatus> & { hookEventName: string }): void =>
    hookListener?.({ paneKey: PANE, source: 'claude', payload: { agentType: 'claude' }, ...status })
  return {
    service,
    client,
    sent,
    sentAccounts,
    registered,
    account,
    spill,
    hook,
    teardown: (paneKey: string) => teardownListener?.(paneKey),
    kinds: () => sent.flatMap((batch) => batch.events.map((event) => event.kind))
  }
}
