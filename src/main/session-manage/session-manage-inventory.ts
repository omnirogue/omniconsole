/**
 * `omni session list`: every conversation the Conversations sidebar holds, observed on this host,
 * and the one lookup every other command uses to find its target among them.
 */

import { sessionManageHostKey, sessionManageMatchesQuery } from '../../shared/session-manage-query'
import { sessionReferenceForRow } from '../../shared/session-reference'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import { pickSessionParityFields } from '../../shared/session-parity'
import type { SessionManageEntry, SessionManageState } from '../../shared/session-manage-types'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import {
  observeSession,
  type ObservedSession,
  type SessionObserveSources
} from './session-manage-observe'
import { projectSessionState } from './session-manage-state'
import {
  sameSessionWorkflowAnchor,
  type SessionWorkflowAnchorRef
} from '../../shared/session-workflow-anchor'

/** Each observation may read a terminal; a hundred rows must not read a hundred at once. */
const OBSERVE_CONCURRENCY = 8

export type SessionManageListFilter = {
  hostId?: string
  query?: string
  states?: readonly SessionManageState[]
  /** A folder id, or the Saved Sessions root id. */
  folderId?: string
  /** Only rows the window marked as the named project's threads. */
  projectThreads?: boolean
  includeArchived?: boolean
}

export function toSessionManageEntry(observed: ObservedSession): SessionManageEntry {
  const { row, facts } = observed
  const { state, waitingOn } = projectSessionState(facts)
  const ref = sessionReferenceForRow(row)
  return {
    paneKey: row.paneKey,
    tabId: row.tabId,
    terminal: observed.terminal,
    title: row.title,
    agent: row.agent,
    kind: row.kind === 'structured' ? 'chat' : 'terminal',
    worktreeId: row.worktreeId,
    worktreePath: row.worktreePath,
    workspace: row.workspace,
    hostId: row.hostId,
    folder: row.folder,
    saved: row.saved,
    archived: row.archived,
    pinned: row.pinned,
    verdict: facts.verdict,
    state,
    stateBasis: state === 'unknown' ? 'none' : observed.stateBasis,
    agentForeground: observed.agentForeground,
    lastActivityAt: observed.lastActivityAt,
    waitingOn,
    ...(state === 'awaiting-user' && observed.prompt ? { ask: observed.prompt.ask } : {}),
    pendingSteps: [...facts.pendingSteps],
    queueLength: facts.queueLength,
    keepGoing: observed.keepGoing,
    ...(ref ? { ref } : {}),
    ...(row.providerSessionId !== undefined ? { providerSessionId: row.providerSessionId } : {}),
    ...(row.transcriptPath !== undefined ? { transcriptPath: row.transcriptPath } : {}),
    ...(row.archiveKind !== undefined ? { archiveKind: row.archiveKind } : {}),
    ...(row.agentTemplate !== undefined ? { agentTemplate: row.agentTemplate } : {}),
    ...(row.agentSession !== undefined ? { agentSession: row.agentSession } : {}),
    ...(row.projectThread ? { projectStatus: row.projectThread.status } : {}),
    ...(row.projectThread?.coordinator ? { projectCoordinator: true as const } : {}),
    ...(observed.workflow ? { workflow: observed.workflow } : {}),
    // Session parity (step 8): the row's bucket fields under sidebar-counts' names (C5).
    ...pickSessionParityFields(row)
  }
}

/** What other parts of this host know of a listed session: the steward's Stalled, its waiters. */
export type SessionManageEntryAnnotator = (
  entry: SessionManageEntry,
  row: SessionManageSidebarRow
) => Pick<SessionManageEntry, 'stalled' | 'waitedOnBy'>

let annotator: SessionManageEntryAnnotator | null = null

/** Returns the restore; `session list` adds what it answers to each entry. */
export function setSessionManageEntryAnnotator(
  next: SessionManageEntryAnnotator | null
): () => void {
  const previous = annotator
  annotator = next
  return () => {
    annotator = previous
  }
}

function annotated(entry: SessionManageEntry, row: SessionManageSidebarRow): SessionManageEntry {
  if (!annotator) {
    return entry
  }
  try {
    const extra = annotator(entry, row)
    return {
      ...entry,
      ...(extra.stalled ? { stalled: extra.stalled } : {}),
      ...(extra.waitedOnBy?.length ? { waitedOnBy: extra.waitedOnBy } : {})
    }
  } catch {
    return entry
  }
}

/** Each row with what this host observed of it, in the sidebar's order. */
export async function observeSessionManageRows(
  rows: readonly SessionManageSidebarRow[],
  sources: SessionObserveSources
): Promise<{ row: SessionManageSidebarRow; entry: SessionManageEntry }[]> {
  const observed = await mapWithConcurrency(rows, OBSERVE_CONCURRENCY, (row) =>
    observeSession(row, sources)
  )
  return observed.map((session) => ({ row: session.row, entry: toSessionManageEntry(session) }))
}

export async function listSessionManageEntries(
  rows: readonly SessionManageSidebarRow[],
  sources: SessionObserveSources,
  filter: SessionManageListFilter = {}
): Promise<SessionManageEntry[]> {
  const listed = rows.filter(
    (row) =>
      !row.folded &&
      (filter.hostId === undefined || sessionManageHostKey(row.hostId) === filter.hostId) &&
      // Why the coordinator stays: an archived project chat is still the project's chat.
      (filter.includeArchived || !row.archived || row.projectThread?.coordinator === true) &&
      (filter.folderId === undefined || row.folderId === filter.folderId) &&
      (!filter.projectThreads || row.projectThread !== undefined)
  )
  const entries = (await observeSessionManageRows(listed, sources)).map(({ row, entry }) =>
    annotated(entry, row)
  )
  return entries.filter(
    (entry) =>
      (!filter.states?.length || filter.states.includes(entry.state)) &&
      (!filter.query || sessionManageMatchesQuery(entry, filter.query))
  )
}

/**
 * The row a `--pane` or `--terminal` names. A named pane must be that exact pane (in that tab, when
 * a tab is named too) and is never replaced by another pane of its tab; only a bare tab resolves
 * to the tab's own row.
 */
export function findSessionManageRow(
  rows: readonly SessionManageSidebarRow[],
  target: { paneKey?: string; tabId?: string; workflow?: SessionWorkflowAnchorRef },
  /** Delete only: a tab id may also name a row with no pane (a tab left from an earlier run). */
  options: { tabOnly?: boolean } = {}
): SessionManageSidebarRow | null {
  if (target.workflow) {
    // Why exact: a workflow anchor is named by its controller and run; another run in the same
    // tab, or any other pane-less row there, is never taken in its place.
    const ref = target.workflow
    return (
      rows.find(
        (row) =>
          row.paneKey === null &&
          (!target.tabId || row.tabId === target.tabId) &&
          sameSessionWorkflowAnchor(row.workflow, ref)
      ) ?? null
    )
  }
  if (target.paneKey) {
    return (
      rows.find(
        (row) => row.paneKey === target.paneKey && (!target.tabId || row.tabId === target.tabId)
      ) ?? null
    )
  }
  if (!target.tabId) {
    return null
  }
  return (
    rows.find((row) => row.tabId === target.tabId && row.paneKey !== null) ??
    (options.tabOnly ? rows.find((row) => row.tabId === target.tabId) : undefined) ??
    null
  )
}

export function describeMissingTarget(target: { paneKey?: string; tabId?: string }): string {
  return target.paneKey
    ? `No conversation in the sidebar has pane ${target.paneKey}. Run omni session list to see them.`
    : `No conversation in the sidebar lives in tab ${target.tabId}. Run omni session list to see them.`
}
