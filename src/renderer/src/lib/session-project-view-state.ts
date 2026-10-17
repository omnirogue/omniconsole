import { z } from 'zod'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { ModelLineage } from '../../../shared/model-lineage'
import { SESSION_PROJECT_THREAD_STATUSES } from '../../../shared/session-project-thread-status'
import type { SessionProjectThreadFilter } from './session-project-threads'

const STORAGE_KEY = 'omni.session-project-view.v1'
const MAX_REMEMBERED_PROJECTS = 200

/** What the Project page's filter bar holds for one project, kept per device. */
const sessionProjectViewStateSchema = z.object({
  statuses: z.array(z.enum(SESSION_PROJECT_THREAD_STATUSES)).max(16).catch([]),
  agents: z.array(z.string().max(80)).max(64).catch([]),
  modelFamilies: z.array(z.string().max(40)).max(32).catch([]),
  hosts: z.array(z.string().max(200)).max(64).catch([]),
  /** Jira issue keys; `none` keeps the threads with no issue. */
  tasks: z.array(z.string().max(80)).max(64).catch([]),
  includeArchived: z.boolean().catch(false),
  search: z.string().max(200).catch('')
})

export type SessionProjectViewState = z.infer<typeof sessionProjectViewStateSchema>

export function emptySessionProjectViewState(): SessionProjectViewState {
  return {
    statuses: [],
    agents: [],
    modelFamilies: [],
    hosts: [],
    tasks: [],
    includeArchived: false,
    search: ''
  }
}

export function isSessionProjectViewFiltered(state: SessionProjectViewState): boolean {
  return (
    state.statuses.length > 0 ||
    state.agents.length > 0 ||
    state.modelFamilies.length > 0 ||
    state.hosts.length > 0 ||
    state.tasks.length > 0 ||
    state.search.trim().length > 0
  )
}

/** The filter the thread list applies; search is applied separately, on the rows' text. */
export function sessionProjectViewFilter(
  state: SessionProjectViewState
): SessionProjectThreadFilter {
  return {
    statuses: state.statuses,
    agents: state.agents,
    modelFamilies: state.modelFamilies as ModelLineage[],
    hosts: state.hosts as ExecutionHostId[],
    tasks: state.tasks,
    includeArchived: state.includeArchived
  }
}

function readAll(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** The project's remembered filter, field by field; a damaged or missing entry is empty. */
export function readSessionProjectViewState(folderId: string): SessionProjectViewState {
  const entry = readAll()[folderId]
  if (!entry || typeof entry !== 'object') {
    return emptySessionProjectViewState()
  }
  const parsed = sessionProjectViewStateSchema.safeParse(entry)
  return parsed.success ? parsed.data : emptySessionProjectViewState()
}

export function saveSessionProjectViewState(
  folderId: string,
  state: SessionProjectViewState
): void {
  try {
    const all = readAll()
    delete all[folderId]
    // Why: the newest project goes last, so the oldest entries are the ones trimmed.
    const kept = Object.entries(all).slice(-(MAX_REMEMBERED_PROJECTS - 1))
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(Object.fromEntries([...kept, [folderId, state]]))
    )
  } catch {
    // Why: presentation only; a storage failure must not block filtering.
  }
}
