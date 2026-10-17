import { updateLedgerResumeIdentity, persistLedgerPane } from './ledger-verified-resume'
import { restoreLedgerPane } from './ledger-pane-restore'
import { randomBytes } from 'node:crypto'
import { ATTEMPT_ID_PATTERN, type LedgerLocalSession } from '../../shared/session-ledger-contract'
import {
  LEDGER_PANE_REGISTRY_MAX,
  type LedgerPaneStore,
  type LedgerResumeIdentity,
  type PersistedPane
} from './ledger-pane-store'

export {
  LEDGER_PANE_REGISTRY_MAX,
  parsePersistedPanes,
  type LedgerPaneStore
} from './ledger-pane-store'

import {
  OMNI_LEDGER_ATTEMPT_ID_ENV,
  OMNI_LEDGER_SESSION_ID_ENV
} from '../../shared/session-ledger-env'

export { OMNI_LEDGER_ATTEMPT_ID_ENV, OMNI_LEDGER_SESSION_ID_ENV }

export function mintLedgerId(): string {
  return `als_${randomBytes(12).toString('hex')}`
}

export function mintAttemptId(): string {
  return `att_${randomBytes(8).toString('hex')}`
}

export type LedgerPaneEntry = {
  paneKey: string
  ledgerId: string
  attemptId: string
  /** The PTY currently bound to the pane; changes on every spawn in it. */
  ptyId: string | null
  /**
   * The pane's process runs on another host (its hooks arrive over an SSH connection, or it
   * was never spawned here). Losing it is never evidence of death (ssh-execution-boundary).
   */
  remote: boolean
  cwd: string | null
  repo: string | null
  branch: string | null
  cardId: string | null
  cardTitle: string | null
  /**
   * Who said this row serves that card: the workspace's explicit link, or a person who added
   * the conversation to a task. A workspace link still wins, but a workspace with NO link of
   * its own never clears a person's (`ledger-card-links.ts`).
   */
  cardLinkedBy: 'workspace' | 'person' | null
  /** The workspace the pane runs in; the explicit card link is read from it. */
  worktreeId: string | null
  agent: string | null
  model: string | null
  nativeSessionId: string | null
  /** Claude's session file; its absence means the id cannot be resumed. */
  sessionFilePath?: string
  verifiedResumeIdentity?: LedgerResumeIdentity
  nativeSessionKey?: 'session_id' | 'conversation_id' | null
  /** Undefined means the execution host was never established. */
  connectionId?: string | null
  /** The signed-in account the row was opened under; every later write is bound to it. */
  account: string | null
  /** Carried over from a previous run's registry; never adopted by a later sign-in. */
  restored: boolean
  startedAt: string
  /** Set once the row's `session_start` (or this attempt's `attempt_start`) is queued. */
  started: boolean
  /** Reason the next start event should carry; null once emitted. */
  pendingStart: 'session_start' | 'attempt_start' | null
  /** Why this attempt exists: a spawn in the pane (resume) or hooks after its attempt ended (reconnect). */
  attemptReason: 'resume' | 'reconnect'
  /** A stop{exit|close|quit} went out for this attempt; cleared by the next stamp. */
  ended: boolean
}

/**
 * paneKey → ledger identity. One ledger row per pane for its whole life; every PTY spawn
 * in a pane that already has a row (a resume, a reconnect, a restored tab after restart)
 * keeps the ledger id and mints a new attempt id.
 */
export class LedgerPaneRegistry {
  private readonly entries = new Map<string, LedgerPaneEntry>()
  private readonly listeners = new Set<(rows: LedgerLocalSession[]) => void>()
  private store: LedgerPaneStore | null = null

  constructor(
    store: LedgerPaneStore | null = null,
    private readonly now: () => Date = () => new Date()
  ) {
    if (store) {
      this.attachStore(store)
    }
  }

  /**
   * Adopt the persisted panes of the last run and persist from now on. Panes stamped before
   * the store was attached (a spawn ahead of `start()`) keep their live identity.
   */
  attachStore(store: LedgerPaneStore): void {
    this.store = store
    let persisted: PersistedPane[] = []
    try {
      persisted = store.load()
    } catch {
      // Why: an unreadable registry costs resume links, never a session.
    }
    for (const pane of persisted) {
      if (this.entries.has(pane.paneKey)) {
        continue
      }
      this.entries.set(pane.paneKey, restoreLedgerPane(pane))
    }
    this.bound()
    this.persist()
  }

  /** Stamp (or re-stamp) a pane at spawn time; returns the env pair the CLI inherits. */
  stamp(
    paneKey: string,
    spawn: {
      ptyId?: string | null
      cwd?: string | null
      worktreeId?: string | null
      attemptReason?: 'resume' | 'reconnect'
    } = {}
  ): { entry: LedgerPaneEntry; resumed: boolean; env: Record<string, string> } {
    const existing = this.entries.get(paneKey)
    // Why: two env builders can run for one spawn; the same PTY re-stamping before its
    // attempt has started keeps the ids it was already given.
    if (
      existing &&
      spawn.ptyId &&
      existing.ptyId === spawn.ptyId &&
      existing.pendingStart !== null
    ) {
      return {
        entry: existing,
        resumed: existing.pendingStart === 'attempt_start',
        env: {
          [OMNI_LEDGER_SESSION_ID_ENV]: existing.ledgerId,
          [OMNI_LEDGER_ATTEMPT_ID_ENV]: existing.attemptId
        }
      }
    }
    const resumed = existing !== undefined
    const attemptId = mintAttemptId()
    const entry: LedgerPaneEntry = existing
      ? {
          ...existing,
          attemptId,
          ptyId: spawn.ptyId ?? existing.ptyId,
          // Why: a spawn stamped on this host makes the pane local again.
          remote: spawn.ptyId ? false : existing.remote,
          cwd: spawn.cwd ?? existing.cwd,
          worktreeId: spawn.worktreeId ?? existing.worktreeId,
          started: false,
          // Why: a start that never went out (the PTY died before its first hook) stays owed as
          // session_start; a row that has started, or was restored from disk, resumes.
          pendingStart:
            existing.started || existing.pendingStart === null
              ? 'attempt_start'
              : existing.pendingStart,
          attemptReason: spawn.attemptReason ?? 'resume',
          ended: false
        }
      : {
          paneKey,
          ledgerId: mintLedgerId(),
          attemptId,
          ptyId: spawn.ptyId ?? null,
          remote: !spawn.ptyId,
          cwd: spawn.cwd ?? null,
          repo: null,
          branch: null,
          cardId: null,
          cardTitle: null,
          cardLinkedBy: null,
          worktreeId: spawn.worktreeId ?? null,
          agent: null,
          model: null,
          nativeSessionId: null,
          account: null,
          restored: false,
          startedAt: this.now().toISOString(),
          started: false,
          pendingStart: 'session_start',
          attemptReason: 'resume',
          ended: false
        }
    this.entries.delete(paneKey)
    this.entries.set(paneKey, entry)
    this.bound()
    this.persist()
    this.notify()
    return {
      entry,
      resumed,
      env: {
        [OMNI_LEDGER_SESSION_ID_ENV]: entry.ledgerId,
        [OMNI_LEDGER_ATTEMPT_ID_ENV]: entry.attemptId
      }
    }
  }

  /**
   * A pane seen only through hooks (an SSH pane, a hook before its spawn stamp) still gets a
   * row; hooks after its attempt ended (a `/clear`, an SSH reconnect) open a new attempt on
   * the same row — a done attempt never reopens (contract §3).
   */
  ensure(paneKey: string, options: { reopenEnded?: boolean } = {}): LedgerPaneEntry {
    const existing = this.entries.get(paneKey)
    if (existing && existing.attemptId && !(existing.ended && options.reopenEnded)) {
      return existing
    }
    return this.stamp(paneKey, existing ? { attemptReason: 'reconnect' } : {}).entry
  }

  get(paneKey: string): LedgerPaneEntry | undefined {
    return this.entries.get(paneKey)
  }

  byLedgerId(ledgerId: string): LedgerPaneEntry | undefined {
    for (const entry of this.entries.values()) {
      if (entry.ledgerId === ledgerId) {
        return entry
      }
    }
    return undefined
  }

  byPtyId(ptyId: string): LedgerPaneEntry | undefined {
    for (const entry of this.entries.values()) {
      if (entry.ptyId === ptyId) {
        return entry
      }
    }
    return undefined
  }

  byNativeSessionId(nativeSessionId: string): LedgerPaneEntry | undefined {
    for (const entry of this.entries.values()) {
      if (entry.nativeSessionId === nativeSessionId) {
        return entry
      }
    }
    return undefined
  }

  panesForNativeSession(nativeSessionId: string): LedgerPaneEntry[] {
    return [...this.entries.values()].filter((entry) => entry.nativeSessionId === nativeSessionId)
  }

  panesForTab(tabId: string): LedgerPaneEntry[] {
    return [...this.entries.values()].filter((entry) => entry.paneKey.startsWith(`${tabId}:`))
  }

  update(paneKey: string, patch: Partial<Omit<LedgerPaneEntry, 'paneKey' | 'ledgerId'>>): void {
    const entry = this.entries.get(paneKey)
    if (!entry) {
      return
    }
    updateLedgerResumeIdentity(entry, patch)
    if (
      [
        'repo',
        'branch',
        'cardId',
        'cardTitle',
        'cardLinkedBy',
        'account',
        'worktreeId',
        'agent',
        'nativeSessionId',
        'nativeSessionKey',
        'sessionFilePath',
        'connectionId'
      ].some((key) => key in patch)
    ) {
      this.persist()
    }
    if (['repo', 'branch', 'cardId', 'started', 'ended', 'account'].some((key) => key in patch)) {
      this.notify()
    }
  }

  remove(paneKey: string): LedgerPaneEntry | undefined {
    const entry = this.entries.get(paneKey)
    if (entry) {
      this.entries.delete(paneKey)
      this.persist()
      this.notify()
    }
    return entry
  }

  /**
   * Panes whose row has started and not ended, in the preload's shape. With `owner` given,
   * only that account's rows: a signed-in person never sees (or can mark) an ownerless row;
   * signed out, only ownerless rows show.
   */
  localSessions(owner?: string | null): LedgerLocalSession[] {
    return [...this.entries.values()]
      .filter((entry) => entry.started && !entry.ended && ATTEMPT_ID_PATTERN.test(entry.attemptId))
      .filter((entry) => owner === undefined || entry.account === owner)
      .map((entry) => ({
        paneId: entry.paneKey,
        ledgerId: entry.ledgerId,
        attemptId: entry.attemptId,
        repo: entry.repo,
        branch: entry.branch,
        cardId: entry.cardId
      }))
  }

  subscribe(listener: (rows: LedgerLocalSession[]) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private bound(): void {
    while (this.entries.size > LEDGER_PANE_REGISTRY_MAX) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.entries.delete(oldest)
    }
  }

  private persist(): void {
    if (!this.store) {
      return
    }
    try {
      this.store.save([...this.entries.values()].map(persistLedgerPane))
    } catch {
      // Why: the registry is a convenience across restarts; a failed save costs one resume link, never a session.
    }
  }

  private notify(): void {
    const rows = this.localSessions()
    for (const listener of this.listeners) {
      try {
        listener(rows)
      } catch {
        // one listener must not strand the rest
      }
    }
  }
}

export { ledgerIdForPane, ledgerIdForSession, setActiveLedgerPaneRegistry } from './ledger-lookup'
