import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { Tab } from '../../../shared/tab-types'
import {
  HOST_TERMINAL_SURFACE_SEPARATOR,
  isWebTerminalSurfaceTabId
} from '../../../shared/terminal-surface-id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import { isAgentStartInFlightForTab } from '@/lib/agent-start-in-flight'
import { getPersonRevealedAt, RECENT_HUMAN_TOUCH_MS } from '@/lib/restore-flood-guard'
import { isTabRevealed } from '@/components/terminal/deferred-startup-mount'
import { resolveWebAgentSessionHandoff } from './web-agent-session-handoff'

/**
 * Rows in a workspace the saved catalog credits to one paired environment (session-count fix, A4).
 *
 * Every process of such a workspace runs on its catalog owner, so a receiver row there that carries
 * no owner evidence of its own — no PTY, no unified-tab execution host — is the owner's mirror by
 * catalog: the owner's complete membership (step 6) reconciles it like a row whose evidence names
 * the owner, kept while listed and removed once omitted. Web-terminal mirror ids are already claimed
 * that way by the owner buckets; this covers the client-minted ids (plain UUIDs) the receiver makes
 * when it reopens a hibernated conversation of that workspace, which no owner frame ever claimed —
 * live on 5 Oct the Studio held 23 of them in the MacBook's Work folder through every MacBook frame.
 * Removal only retracts mirror visibility: no process is stopped and no transcript is touched.
 */

export type CatalogOwnedRowsState = {
  ptyIdsByTabId: Readonly<Record<string, readonly string[] | undefined>>
  terminalLayoutsByTabId: Readonly<Record<string, TerminalLayoutSnapshot | undefined>>
  unifiedTabsByWorktree: Readonly<Record<string, readonly Tab[] | undefined>>
  pendingStartupByTabId?: Readonly<Record<string, { deferUntilRevealed?: true } | undefined>>
  sleepingAgentSessionsByPaneKey?: Readonly<Record<string, SleepingAgentSessionRecord>>
}

function isClientMintedTerminalId(tabId: string): boolean {
  return !isWebTerminalSurfaceTabId(tabId) && !tabId.includes(HOST_TERMINAL_SURFACE_SEPARATOR)
}

function sleepingRecordTabId(record: SleepingAgentSessionRecord): string | null {
  return record.tabId ?? parsePaneKey(record.paneKey)?.tabId ?? null
}

function hasPtyEvidence(state: CatalogOwnedRowsState, tab: TerminalTab): boolean {
  return (
    Boolean(tab.ptyId) ||
    Object.values(state.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {}).some(Boolean) ||
    (state.ptyIdsByTabId[tab.id]?.length ?? 0) > 0
  )
}

/** Whether something is opening or creating this client-minted row right now. */
function isClientRowInFlight(
  state: CatalogOwnedRowsState,
  tab: TerminalTab,
  environmentId: string,
  worktreeId: string
): boolean {
  const startup = state.pendingStartupByTabId?.[tab.id]
  const phoneRevealedAt = getPersonRevealedAt(tab.id)
  return (
    // Why: a client-minted row without a PTY is also how a surface this window is creating on the
    // owner looks: a queued (not reveal-deferred) start, an agent start waiting for its PTY, a
    // copy opened on the desktop (deferred-startup-mount) or the phone, or a recorded host
    // handoff. Removing one mid-resume would tear down its transport (and the remote terminal).
    (startup !== undefined && startup.deferUntilRevealed !== true) ||
    isAgentStartInFlightForTab(tab.id) ||
    isTabRevealed(tab.id) ||
    (phoneRevealedAt !== undefined && Date.now() - phoneRevealedAt <= RECENT_HUMAN_TOUCH_MS) ||
    resolveWebAgentSessionHandoff({ environmentId, worktreeId, provisionalTabId: tab.id }) !== null
  )
}

/**
 * Whether `environmentId`'s frame may reconcile a client-minted row of `worktreeId`: the catalog
 * credits the workspace to it and the row is a conversation copy at rest with no owner evidence.
 */
export function createCatalogOwnedClientRowClaim(
  state: CatalogOwnedRowsState,
  worktreeId: string,
  environmentId: string,
  catalogOwnerEnvironmentId: string | null
): (tab: TerminalTab) => boolean {
  if (catalogOwnerEnvironmentId !== environmentId) {
    return () => false
  }
  let indexes: {
    stampedTabIds: Set<string>
    recordTabIds: Set<string>
    connectionRecordTabIds: Set<string>
  } | null = null
  const resolveIndexes = (): NonNullable<typeof indexes> => {
    if (indexes) {
      return indexes
    }
    const recordTabIds = new Set<string>()
    const connectionRecordTabIds = new Set<string>()
    for (const record of Object.values(state.sleepingAgentSessionsByPaneKey ?? {})) {
      const tabId = record.worktreeId === worktreeId ? sleepingRecordTabId(record) : null
      if (tabId !== null) {
        ;(record.connectionId ? connectionRecordTabIds : recordTabIds).add(tabId)
      }
    }
    indexes = {
      stampedTabIds: new Set(
        (state.unifiedTabsByWorktree[worktreeId] ?? [])
          .filter((unified) => unified.contentType === 'terminal' && unified.executionHostId)
          .map((unified) => unified.entityId)
      ),
      recordTabIds,
      connectionRecordTabIds
    }
    return indexes
  }
  return (tab) => {
    if (
      !isClientMintedTerminalId(tab.id) ||
      tab.localWorkflow ||
      tab.conversationLaunchPending ||
      // Why: any PTY is evidence — a remote id names its owner, a local one is this computer's.
      hasPtyEvidence(state, tab) ||
      isClientRowInFlight(state, tab, environmentId, worktreeId)
    ) {
      return false
    }
    const { stampedTabIds, recordTabIds, connectionRecordTabIds } = resolveIndexes()
    if (stampedTabIds.has(tab.id) || connectionRecordTabIds.has(tab.id)) {
      // Why: a unified-tab execution host, or a record naming an SSH connection, is evidence.
      return false
    }
    // Why agent identity: a bare shell with no PTY may be a never-visited workspace's first shell
    // about to spawn; a conversation copy at rest is not, and only conversations make rows.
    return Boolean(tab.launchAgent) || recordTabIds.has(tab.id)
  }
}

/**
 * Drops every hibernation record attached to the client-minted copies a catalog owner's complete
 * membership just removed from `worktreeId`.
 *
 * Why every origin: the activation sweep re-keys a record onto the copy's pane as-is, so a copy's
 * record may be quit/live, worktree-sleep or legacy (no origin) alike. The sidebar shows a record
 * with no tab as a conversation of its own, so removing only the tab changed no count, and the
 * next sweep reopened the record as a fresh copy. Records naming an SSH connection stay (they
 * name another host, and their copy is never claimed). The same drop retires the records of an
 * owner's mirror panes its complete membership omits (web-session-mirror-sleeping-records).
 */
export function retractCatalogOwnedCopySleepingRecords(
  records: Readonly<Record<string, SleepingAgentSessionRecord>> | undefined,
  worktreeId: string,
  removedCopyTabIds: ReadonlySet<string>
): { records: Record<string, SleepingAgentSessionRecord>; retractedPaneKeys: string[] } | null {
  if (removedCopyTabIds.size === 0) {
    return null
  }
  let next: Record<string, SleepingAgentSessionRecord> | null = null
  const retractedPaneKeys: string[] = []
  for (const [paneKey, record] of Object.entries(records ?? {})) {
    const tabId = sleepingRecordTabId(record)
    if (
      record.worktreeId !== worktreeId ||
      record.connectionId ||
      tabId === null ||
      !removedCopyTabIds.has(tabId)
    ) {
      continue
    }
    next ??= { ...records }
    delete next[paneKey]
    retractedPaneKeys.push(paneKey)
  }
  return next ? { records: next, retractedPaneKeys } : null
}
