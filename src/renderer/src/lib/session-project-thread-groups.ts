import {
  SESSION_PROJECT_THREAD_STATUSES,
  type SessionProjectThreadStatus
} from '../../../shared/session-project-thread-status'
import type { SessionProjectThread } from './session-project-threads'

/** The order the Project page groups threads in: what needs the person first. */
export const SESSION_PROJECT_STATUS_ORDER: readonly SessionProjectThreadStatus[] = [
  'needsYou',
  'reviewReady',
  'working',
  'waiting',
  'done',
  'stopped',
  'cantSee'
]

/** Rows with no state (idle, no agent) are listed last under their own heading. */
export type SessionProjectThreadGroupKey = SessionProjectThreadStatus | 'idle'

export const SESSION_PROJECT_GROUP_ORDER: readonly SessionProjectThreadGroupKey[] = [
  ...SESSION_PROJECT_STATUS_ORDER,
  'idle'
]

export type SessionProjectThreadGroup = {
  key: SessionProjectThreadGroupKey
  threads: SessionProjectThread[]
}

export function sessionProjectThreadGroupKey(
  thread: Pick<SessionProjectThread, 'status'>
): SessionProjectThreadGroupKey {
  return thread.status ?? 'idle'
}

/** The coordinator first, then newest activity first; rows with no report keep their order last. */
export function sortSessionProjectThreads(
  threads: readonly SessionProjectThread[]
): SessionProjectThread[] {
  return [...threads].sort(
    (a, b) =>
      Number(b.isCoordinator) - Number(a.isCoordinator) ||
      (b.lastActivityAt ?? -1) - (a.lastActivityAt ?? -1)
  )
}

/** The page's groups in reading order; an empty group is left out, except Needs you. */
export function groupSessionProjectThreads(
  threads: readonly SessionProjectThread[]
): SessionProjectThreadGroup[] {
  const byKey = new Map<SessionProjectThreadGroupKey, SessionProjectThread[]>()
  for (const thread of threads) {
    const key = sessionProjectThreadGroupKey(thread)
    byKey.set(key, [...(byKey.get(key) ?? []), thread])
  }
  return SESSION_PROJECT_GROUP_ORDER.map((key) => ({ key, threads: byKey.get(key) ?? [] })).filter(
    (group) => group.threads.length > 0 || group.key === 'needsYou'
  )
}

/** How many threads each group would hold; the filter bar's chips show these before filtering. */
export function countSessionProjectThreadGroups(
  threads: readonly SessionProjectThread[]
): Record<SessionProjectThreadGroupKey, number> {
  const counts = Object.fromEntries(SESSION_PROJECT_GROUP_ORDER.map((key) => [key, 0])) as Record<
    SessionProjectThreadGroupKey,
    number
  >
  for (const thread of threads) {
    counts[sessionProjectThreadGroupKey(thread)] += 1
  }
  return counts
}

/** The page's search: the row's title, workspace, agent or model, case-insensitively. */
export function searchSessionProjectThreads(
  threads: readonly SessionProjectThread[],
  query: string
): SessionProjectThread[] {
  const needle = query.trim().toLowerCase()
  if (!needle) {
    return [...threads]
  }
  return threads.filter((thread) =>
    [thread.row.session.label, thread.row.session.workspaceLabel, thread.agent, thread.model]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLowerCase().includes(needle))
  )
}

/** Every status the shared contract names is grouped somewhere; a new one must get a place. */
export function sessionProjectStatusesWithoutAGroup(): SessionProjectThreadStatus[] {
  return SESSION_PROJECT_THREAD_STATUSES.filter(
    (status) => !SESSION_PROJECT_STATUS_ORDER.includes(status)
  )
}
