import type { GitRead } from './ledger-commit-observer'
import type { SessionLedgerClient } from './ledger-client'
import type { LedgerSpillStore } from './ledger-event-queue'
import type { LedgerPaneStore } from './ledger-identity'
import type { LedgerLinkedCard } from './ledger-linked-card'

/** The slice of an accepted hook status the ledger consumes. */
export type LedgerHookStatus = {
  paneKey: string
  worktreeId?: string
  source?: string
  hookEventName?: string
  toolAgentType?: string
  isReplay?: boolean
  /** The SSH connection the hook arrived on; null (or absent) for a local pane. */
  connectionId?: string | null
  providerSessionOnly?: boolean
  providerSession?: { id?: string; key?: 'session_id' | 'conversation_id' }
  payload: {
    agentType?: string
    model?: string
    toolName?: string
    toolInput?: string
  }
}

export type SessionLedgerServiceDeps = {
  client?: SessionLedgerClient
  host?: () => string
  /** The signed-in principal's stable id; batches are bound to it (see the queue). */
  principal?: () => string | null
  subscribeHookStatus?: (listener: (status: LedgerHookStatus) => void) => () => void
  subscribePaneTeardown?: (listener: (paneKey: string) => void) => () => void
  resolveGitIdentity?: (cwd: string) => Promise<{ repo: string | null; branch: string | null }>
  /** Bounded git reads for commit observation; absent, the real binary in the pane's cwd. */
  readGit?: GitRead
  /** The explicit work-item link of a workspace (brief §7); wired once the store exists. */
  linkedCard?: (worktreeId: string) => LedgerLinkedCard | null
  paneStore?: LedgerPaneStore | null
  spillStore?: LedgerSpillStore | null
  mutedRepos?: {
    read(): string[]
    set(repo: string, muted: boolean): string[]
  }
  warn?: (message: string) => void
}

/** What a PTY spawn tells the ledger about its pane. */
export type LedgerPaneSpawn = {
  paneKey: string
  ptyId?: string | null
  cwd?: string | null
  worktreeId?: string | null
  /** A `TuiAgent` slug or any provider name a spawn names. */
  launchAgent?: string
}
