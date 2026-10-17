/**
 * This host's own sessions as the owner service reads them, with or without a window: the window's
 * rows while one answers (kept on disk), else the rows it last listed. Every row is observed live
 * on this runtime, so a remembered row only says where to look: a pane nothing here resolves reads
 * `unverifiable`, never `exited` (`observeSession`).
 */

import { readFileSync, statSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { sameConversationSource, type ConversationSource } from '../../shared/conversation-source'
import { parseExecutionHostId } from '../../shared/execution-host'
import type { SessionHostProviderIdentity } from '../../shared/session-host-identity'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type { SessionManageEntry } from '../../shared/session-manage-types'
import { durableWriteTempPath, writeFileDurable } from '../durable-file-write'
import type { TerminalAgentProcessProof } from '../runtime/terminal-agent-process'
import { toSessionManageEntry } from '../session-manage/session-manage-inventory'
import { sessionManageSource, type ObservedSession } from '../session-manage/session-manage-observe'

const OBSERVE_CONCURRENCY = 8

export type HostSession = {
  row: SessionManageSidebarRow
  entry: SessionManageEntry
  source: ConversationSource | null
  agentProcess: TerminalAgentProcessProof | null
}

export type HostSessionInventoryDeps = {
  /** The window's own list; rejects when no window answers. */
  readWindowRows(): Promise<SessionManageSidebarRow[]>
  observe(row: SessionManageSidebarRow): Promise<ObservedSession>
  cacheFile: string
  /**
   * With no window: the remembered rows plus what main's own inventory holds that they lack
   * (session parity, B3), so every reader sees what the main-authored ledger publishes.
   */
  headlessRows?(remembered: readonly SessionManageSidebarRow[]): SessionManageSidebarRow[]
}

export type HostSessionRows = { rows: SessionManageSidebarRow[]; from: 'window' | 'remembered' }

/** The rows a window last listed here, and when (epoch ms; null when none ever was). */
export type HostListedRows = { rows: readonly SessionManageSidebarRow[]; listedAt: number | null }

/**
 * Whether this row can be that provider conversation. A pane outlives its conversations (a new
 * chat in the same terminal), so a row holding a different provider id is another conversation;
 * a row that has not learned its id yet may still be this one.
 */
export function rowHoldsProvider(
  row: Pick<SessionManageSidebarRow, 'providerSessionId'>,
  provider: SessionHostProviderIdentity | null | undefined
): boolean {
  const sessionId = row.providerSessionId?.trim()
  return !provider || !sessionId || sessionId === provider.sessionId
}

/** Sessions this runtime executes itself; SSH and paired-runtime rows belong to their own hosts. */
export function isHostLocalRow(row: SessionManageSidebarRow): boolean {
  return parseExecutionHostId(row.hostId)?.kind === 'local'
}

function listedAtOf(file: string): number | null {
  try {
    return statSync(file).mtimeMs
  } catch {
    return null
  }
}

function readRemembered(file: string): SessionManageSidebarRow[] {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { v?: number; rows?: unknown }
    return parsed.v === 1 && Array.isArray(parsed.rows)
      ? (parsed.rows as SessionManageSidebarRow[])
      : []
  } catch {
    return []
  }
}

export class HostSessionInventory {
  private remembered: SessionManageSidebarRow[] | null = null
  private listedAt: number | null = null
  private savedJson: string | null = null
  private saving: Promise<void> = Promise.resolve()

  constructor(private readonly deps: HostSessionInventoryDeps) {}

  async rows(): Promise<HostSessionRows> {
    try {
      const rows = (await this.deps.readWindowRows()).filter(isHostLocalRow)
      this.remember(rows)
      return { rows, from: 'window' }
    } catch {
      return { rows: this.withHeadlessRows(this.loadRemembered()), from: 'remembered' }
    }
  }

  private withHeadlessRows(remembered: SessionManageSidebarRow[]): SessionManageSidebarRow[] {
    try {
      return this.deps.headlessRows?.(remembered) ?? remembered
    } catch (error) {
      // Why the remembered rows still: a failed read of main's inventory must not empty the list.
      console.warn('[session-host] reading the windowless inventory failed', error)
      return remembered
    }
  }

  /** Synchronous, for a publication: no window is asked. */
  lastListed(): HostListedRows {
    return { rows: this.loadRemembered(), listedAt: this.listedAt }
  }

  async list(): Promise<HostSession[]> {
    const { rows } = await this.rows()
    // Why bounded: each observation may read a terminal, and a host can hold a hundred sessions.
    return await mapWithConcurrency(
      rows.filter((row) => !row.folded),
      OBSERVE_CONCURRENCY,
      (row) => this.read(row)
    )
  }

  /** The row that addresses this conversation, not observed; null when no row does. */
  async rowFor(
    source: ConversationSource,
    provider?: SessionHostProviderIdentity | null
  ): Promise<SessionManageSidebarRow | null> {
    const { rows } = await this.rows()
    return (
      rows.find((candidate) => {
        const candidateSource = sessionManageSource(candidate)
        return (
          candidateSource !== null &&
          sameConversationSource(candidateSource, source) &&
          rowHoldsProvider(candidate, provider)
        )
      }) ?? null
    )
  }

  /** The row that addresses this conversation, observed now; null when no row does. */
  async find(
    source: ConversationSource,
    provider?: SessionHostProviderIdentity | null
  ): Promise<HostSession | null> {
    const row = await this.rowFor(source, provider)
    return row ? await this.read(row) : null
  }

  async read(row: SessionManageSidebarRow): Promise<HostSession> {
    const observed = await this.deps.observe(row)
    return {
      row,
      entry: toSessionManageEntry(observed),
      source: observed.source,
      agentProcess: observed.agentProcess
    }
  }

  /** Settles once the last listed rows are on disk (tests and shutdown). */
  flush(): Promise<void> {
    return this.saving
  }

  private loadRemembered(): SessionManageSidebarRow[] {
    if (!this.remembered) {
      // Why the file's time: it is rewritten whenever a listing changes what it holds.
      this.listedAt = listedAtOf(this.deps.cacheFile)
      this.remembered = readRemembered(this.deps.cacheFile)
    }
    return this.remembered
  }

  private remember(rows: SessionManageSidebarRow[]): void {
    this.remembered = rows
    this.listedAt = Date.now()
    const json = JSON.stringify({ v: 1, rows })
    if (json === this.savedJson) {
      return
    }
    this.savedJson = json
    const file = this.deps.cacheFile
    this.saving = this.saving
      .then(() => mkdir(dirname(file), { recursive: true }))
      .then(() => writeFileDurable(durableWriteTempPath(file), file, json))
      .catch((error: unknown) => {
        this.savedJson = null
        console.warn('[session-host] remembering the session list failed', error)
      })
  }
}
