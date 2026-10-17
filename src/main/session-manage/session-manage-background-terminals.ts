/**
 * Runtime-owned terminals that no window tab shows — "running in the background, not in a
 * window" (for example a process an earlier click from another computer started). `session list`
 * shows them, `session tidy` keeps them with that reason unless the person names one with
 * `--delete`, `session show` adopts one into the window, and `terminal close` ends one. Nothing
 * here ends a process by itself.
 */

import type { BackgroundRuntimeTerminal } from '../../shared/background-runtime-terminal'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type { SessionManageEntry, SessionTidyRow } from '../../shared/session-manage-types'
import { sessionManageHostKey } from '../../shared/session-manage-query'
import { listSessionManageEntries, observeSessionManageRows } from './session-manage-inventory'
import type { SessionManageListFilter } from './session-manage-inventory'
import type { SessionObserveSources } from './session-manage-observe'
import { toSessionTidyRow, type SessionTidyVerdict } from './session-manage-tidy'

export type { BackgroundRuntimeTerminal }

export const BACKGROUND_NOT_IN_WINDOW = 'background-not-in-window' as const

export function backgroundTerminalReason(terminal: { paneKey: string | null; handle: string }) {
  const open = terminal.paneKey
    ? `omni session show --pane ${terminal.paneKey}`
    : `omni terminal focus --terminal ${terminal.handle}`
  return `Running in the background, not in a window. Open it with ${open}, or end it with omni terminal close --terminal ${terminal.handle}; tidy ends it only when the person names it with --delete.`
}

function workspacePath(worktreeId: string): string | null {
  const separator = worktreeId.indexOf('::')
  return separator !== -1 ? worktreeId.slice(separator + 2) : null
}

/** One sidebar-shaped row per background terminal the window does not already list. */
export function backgroundTerminalRows(
  terminals: readonly BackgroundRuntimeTerminal[],
  sidebarRows: readonly SessionManageSidebarRow[]
): SessionManageSidebarRow[] {
  const listedPanes = new Set(sidebarRows.map((row) => row.paneKey).filter(Boolean))
  return terminals
    .filter((terminal) => !terminal.paneKey || !listedPanes.has(terminal.paneKey))
    .map((terminal) => {
      const path = workspacePath(terminal.worktreeId)
      const rowKey = `background:${terminal.ptyId}`
      return {
        rowKey,
        viewKey: rowKey,
        paneKey: terminal.paneKey,
        tabId: terminal.tabId,
        kind: 'terminal',
        structuredSessionId: null,
        worktreeId: terminal.worktreeId,
        hostId: terminal.hostId,
        hostUnavailable: false,
        title: terminal.title?.trim() || 'Terminal',
        agent: terminal.launchAgent ?? 'terminal',
        workspace: path ?? terminal.worktreeId,
        worktreePath: path,
        repoId: null,
        repoLabel: null,
        branch: null,
        workspaceKind: 'unknown',
        folderId: null,
        folder: null,
        saved: false,
        archived: false,
        archivedByHand: false,
        pinned: false,
        launchPending: false,
        resumable: false,
        shellForeground: false,
        folded: false
      }
    })
}

function withPlacement(entry: SessionManageEntry): SessionManageEntry {
  return { ...entry, placement: BACKGROUND_NOT_IN_WINDOW }
}

/** `session list`'s background entries, under the same filters as the sidebar's. */
export async function listBackgroundSessionManageEntries(
  terminals: readonly BackgroundRuntimeTerminal[] | null,
  sidebarRows: readonly SessionManageSidebarRow[],
  sources: SessionObserveSources,
  filter: SessionManageListFilter
): Promise<SessionManageEntry[]> {
  if (!terminals?.length) {
    return []
  }
  const rows = backgroundTerminalRows(terminals, sidebarRows)
  return (await listSessionManageEntries(rows, sources, filter)).map(withPlacement)
}

export const BACKGROUND_NO_TAB_TO_ARCHIVE =
  'A background process has no tab to archive; name it with --delete to end it.'

export type BackgroundTidyOptions = {
  include: ReadonlySet<string>
  delete: boolean
  selfPaneKey?: string
  selfTabId?: string
  /** Why a decision or a Question still waits on it (`answer-wait.ts`); tidy never ends it. */
  answerWait?: (terminal: { paneKey: string | null; worktreeId: string }) => string | null
}

/** How `--include` names a background terminal: its pane, or its tab when it has no pane. */
export function backgroundTidyKey(terminal: { paneKey: string | null; tabId: string | null }) {
  return terminal.paneKey ?? terminal.tabId
}

/**
 * Tidy keeps a background terminal with its reason unless the person names it: then `--delete`
 * ends it (the cleanup's own terminal excepted), and archive keeps it, having no tab to archive.
 */
export function classifyBackgroundTidy(
  terminal: BackgroundRuntimeTerminal,
  options: BackgroundTidyOptions
): SessionTidyVerdict {
  const key = backgroundTidyKey(terminal)
  const keep = (reason: string): SessionTidyVerdict => ({
    action: 'skip',
    reason,
    group: BACKGROUND_NOT_IN_WINDOW
  })
  if (!key || !options.include.has(key)) {
    return keep(backgroundTerminalReason(terminal))
  }
  if (!options.delete) {
    return keep(BACKGROUND_NO_TAB_TO_ARCHIVE)
  }
  if (
    (options.selfPaneKey && terminal.paneKey === options.selfPaneKey) ||
    (options.selfTabId && terminal.tabId === options.selfTabId)
  ) {
    return keep('This is the session running the cleanup.')
  }
  const waiting = options.answerWait?.(terminal)
  if (waiting) {
    return { action: 'skip', reason: waiting, group: 'awaiting-answer' }
  }
  return {
    action: 'delete',
    reason: 'Running in the background, not in a window; the request names it, so tidy ends it.',
    included: true
  }
}

/** `session tidy`'s rows for background terminals, in the run's mode and host scope. */
export async function backgroundTidyRows(
  terminals: readonly BackgroundRuntimeTerminal[] | null,
  sidebarRows: readonly SessionManageSidebarRow[],
  sources: SessionObserveSources,
  hostId: string | undefined,
  options: BackgroundTidyOptions = { include: new Set(), delete: false }
): Promise<SessionTidyRow[]> {
  if (!terminals?.length) {
    return []
  }
  const scoped = terminals.filter(
    (terminal) => hostId === undefined || sessionManageHostKey(terminal.hostId) === hostId
  )
  const byRowKey = new Map(scoped.map((terminal) => [`background:${terminal.ptyId}`, terminal]))
  const observed = await observeSessionManageRows(
    backgroundTerminalRows(scoped, sidebarRows),
    sources
  )
  return observed.map(({ row, entry }) =>
    toSessionTidyRow(entry, classifyBackgroundTidy(byRowKey.get(row.rowKey)!, options))
  )
}

/** The background terminal a `--pane` / `--terminal`-style target names, if any. */
export function findBackgroundTerminal(
  terminals: readonly BackgroundRuntimeTerminal[] | null,
  target: { paneKey?: string; tabId?: string }
): BackgroundRuntimeTerminal | null {
  if (!terminals) {
    return null
  }
  if (target.paneKey) {
    return (
      terminals.find(
        (terminal) =>
          terminal.paneKey === target.paneKey && (!target.tabId || terminal.tabId === target.tabId)
      ) ?? null
    )
  }
  return target.tabId
    ? (terminals.find((terminal) => terminal.tabId === target.tabId) ?? null)
    : null
}
