import { useCallback, useEffect, useState } from 'react'
import { create } from 'zustand'
import type { WorkRow } from '../../../../../shared/backoffice-work-views'
import {
  EMPTY_WORK_FILTER,
  filterWorkRows,
  WORK_QUERY_MAX,
  type WorkFilter,
  type WorkLens,
  type WorkSourceFilter,
  type WorkStatusFilter
} from './backoffice-work-labels'

export type WorkSelection = { lens: WorkLens; rowKey: string | null; filter: WorkFilter }

const STORAGE_KEY = 'backoffice-work-selection-v2'
/** The tab-era record; read once, carried across and removed. */
const LEGACY_STORAGE_KEY = 'backoffice-work-selection-v1'
const DEFAULT_SELECTION: WorkSelection = {
  lens: 'needs-you',
  rowKey: null,
  filter: EMPTY_WORK_FILTER
}
const LENSES: readonly WorkLens[] = ['needs-you', 'waiting', 'all']
// Why: the Handoffs tab is gone; its threads are rows of the whole list now.
const LEGACY_TABS: Record<string, WorkLens> = {
  'needs-you': 'needs-you',
  'waiting-for': 'waiting',
  all: 'all',
  handoffs: 'all'
}
const STATUSES: readonly WorkStatusFilter[] = [
  'all',
  'needs-you',
  'waiting',
  'replied',
  'other',
  'finished'
]
const SOURCES: readonly WorkSourceFilter[] = ['all', 'task', 'received', 'sent']

function readFilter(value: unknown): WorkFilter {
  const filter = (value && typeof value === 'object' ? value : {}) as Partial<WorkFilter>
  return {
    person: typeof filter.person === 'string' ? filter.person : EMPTY_WORK_FILTER.person,
    status: STATUSES.includes(filter.status as WorkStatusFilter)
      ? (filter.status as WorkStatusFilter)
      : EMPTY_WORK_FILTER.status,
    project: typeof filter.project === 'string' ? filter.project : EMPTY_WORK_FILTER.project,
    // Why: selections saved before the source and search existed read as "all" and "".
    source: SOURCES.includes(filter.source as WorkSourceFilter)
      ? (filter.source as WorkSourceFilter)
      : EMPTY_WORK_FILTER.source,
    query:
      typeof filter.query === 'string'
        ? filter.query.slice(0, WORK_QUERY_MAX)
        : EMPTY_WORK_FILTER.query
  }
}

function readRecord(raw: string | null, lens: (parsed: Record<string, unknown>) => WorkLens) {
  if (!raw || raw.length > 2000) {
    return null
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>
  return {
    lens: lens(parsed),
    rowKey: typeof parsed.rowKey === 'string' ? parsed.rowKey : null,
    filter: readFilter(parsed.filter)
  }
}

function readSelection(scope: string): WorkSelection {
  try {
    const current = readRecord(localStorage.getItem(`${STORAGE_KEY}:${scope}`), (parsed) =>
      LENSES.includes(parsed.lens as WorkLens) ? (parsed.lens as WorkLens) : 'needs-you'
    )
    if (current) {
      return current
    }
    const legacyKey = `${LEGACY_STORAGE_KEY}:${scope}`
    const legacy = readRecord(
      localStorage.getItem(legacyKey),
      (parsed) => LEGACY_TABS[String(parsed.tab)] ?? 'needs-you'
    )
    if (!legacy) {
      return DEFAULT_SELECTION
    }
    localStorage.removeItem(legacyKey)
    writeSelection(scope, legacy)
    return legacy
  } catch {
    return DEFAULT_SELECTION
  }
}

function writeSelection(scope: string, selection: WorkSelection): void {
  try {
    localStorage.setItem(`${STORAGE_KEY}:${scope}`, JSON.stringify(selection))
  } catch {
    // Why: storage can be unavailable (private profile, quota); the view still works unsaved.
  }
}

// Why: a remembered selection names another account's work; only the current scope's is kept.
function forgetOtherScopes(scope: string): void {
  try {
    const keep = `${STORAGE_KEY}:${scope}`
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index)
      if (
        key !== null &&
        key !== keep &&
        (key.startsWith(`${STORAGE_KEY}:`) || key.startsWith(`${LEGACY_STORAGE_KEY}:`))
      ) {
        localStorage.removeItem(key)
      }
    }
  } catch {
    // Why: storage can be unavailable; then nothing was remembered either.
  }
}

/** The selected lens, row and filter, remembered per account scope; another scope never inherits them. */
export function useBackofficeWorkSelection(scope: string): {
  selection: WorkSelection
  update: (next: Partial<WorkSelection>) => void
} {
  // Why: ordinary entry opens attention; explicit focus requests still select their exact work.
  const entrySelection = (account: string): WorkSelection => ({
    ...readSelection(account),
    lens: 'needs-you',
    rowKey: null
  })
  const [stored, setStored] = useState(() => ({ scope, selection: entrySelection(scope) }))
  const selection = stored.scope === scope ? stored.selection : entrySelection(scope)
  useEffect(() => {
    forgetOtherScopes(scope)
  }, [scope])
  const update = useCallback(
    (next: Partial<WorkSelection>) => {
      const merged = { ...selection, ...next }
      writeSelection(scope, merged)
      setStored({ scope, selection: merged })
    },
    [scope, selection]
  )
  return { selection, update }
}

/**
 * A request from another surface to open identified work, bound to the scope that asked:
 * a row by its key, a handoff thread, or a card (a card may have several rows; the task row wins).
 */
export type WorkFocusRequest = {
  scope: string
  lens?: WorkLens
  rowKey?: string
  threadId?: string
  taskId?: string
}
type WorkFocusMiss = { scope: string; id: string }

/** Other surfaces (Attention, deep links, toasts) ask the Work list to open the same identified work. */
export const useBackofficeWorkFocus = create<{
  request: WorkFocusRequest | null
  /** The last request's id when the loaded lists did not hold it, so the list can say so. */
  missing: WorkFocusMiss | null
  focus: (request: WorkFocusRequest) => void
  settle: (missing: WorkFocusMiss | null) => void
}>((set) => ({
  request: null,
  missing: null,
  focus: (request) => set({ request, missing: null }),
  settle: (missing) => set({ request: null, missing })
}))

/** Select `row` under All, dropping a filter that would hide it. */
export function allLensSelection(row: WorkRow, filter: WorkFilter): WorkSelection {
  return {
    lens: 'all',
    rowKey: row.key,
    filter: filterWorkRows([row], filter).length > 0 ? filter : EMPTY_WORK_FILTER
  }
}

export type WorkFocusOutcome =
  | { kind: 'wait' }
  | { kind: 'drop' }
  | { kind: 'select'; selection: Partial<WorkSelection> }
  | { kind: 'missing'; selection: Partial<WorkSelection>; id: string }

function requestedRow(request: WorkFocusRequest, rows: readonly WorkRow[]): WorkRow | undefined {
  if (request.rowKey) {
    return rows.find((row) => row.key === request.rowKey)
  }
  if (request.threadId) {
    return rows.find((row) => row.thread?.id === request.threadId)
  }
  const matches = rows.filter((row) => row.taskId === request.taskId)
  return matches.find((candidate) => candidate.source === 'task') ?? matches[0]
}

/** How the Work list answers a focus request against the rows it has loaded. */
export function resolveWorkFocus(
  request: WorkFocusRequest,
  scope: string,
  rows: readonly WorkRow[],
  loading: boolean,
  filter: WorkFilter
): WorkFocusOutcome {
  // Why: a request made under another account, organisation or environment never selects rows here.
  if (request.scope !== scope) {
    return { kind: 'drop' }
  }
  const lensOnly: Partial<WorkSelection> = request.lens ? { lens: request.lens, rowKey: null } : {}
  const wanted = request.rowKey ?? request.threadId ?? request.taskId
  if (!wanted) {
    return { kind: 'select', selection: lensOnly }
  }
  const row = requestedRow(request, rows)
  if (row) {
    const selection = allLensSelection(row, filter)
    return {
      kind: 'select',
      selection: request.lens ? { ...selection, lens: request.lens } : selection
    }
  }
  return loading ? { kind: 'wait' } : { kind: 'missing', selection: lensOnly, id: wanted }
}
