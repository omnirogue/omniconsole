import type { ConsoleJiraWorkRef } from '../../../shared/console-jira-work-contract'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { modelLineage, type ModelLineage } from '../../../shared/model-lineage'
import { conversationViewKey } from './conversation-view'
import {
  sessionProjectThreadStatus,
  type SessionProjectThreadStatus
} from './session-folder-rollup'
import { sessionFolderSubtreeIds } from './session-folder-tree'
import type { SessionFolder } from './session-folders'
import type { SessionSidebarTreeRow } from './session-sidebar-group-model'
import { paneLeafIdentity } from './session-sidebar-worker-rows'
import type { SessionTaskLink } from './session-task-link'

const MAX_LINEAGE_DEPTH = 32

/** One thread of a project, as the project page and `omni session list --project` show it. */
export type SessionProjectThread<T extends SessionSidebarTreeRow = SessionSidebarTreeRow> = {
  row: T
  status: SessionProjectThreadStatus | null
  /** The project's chat: the row bound as `ProjectSettings.coordinator`. */
  isCoordinator: boolean
  agent: string
  model?: string
  host?: ExecutionHostId
  /** The thread's own Jira issue, when the task it serves is one. */
  jira?: ConsoleJiraWorkRef
  /** The agent's last status report (ms); null when none is held, as for a sleeping session. */
  lastActivityAt: number | null
  /** The orchestration task that started this worker; `fromChat` when the project chat sent it. */
  origin?: { task: string; fromChat: boolean }
}

export type SessionProjectThreadInputs = {
  /** The sidebar's classification by row key (`buildSessionSidebarTreeRows`). */
  classifications?: ReadonlyMap<string, string>
  /** Worker pane leaf → its launcher's leaf (`orchestration.workerLineage`, #911). */
  workerParentByLeaf?: ReadonlyMap<string, string>
  /** `ProjectSettings.coordinator.sessionKey`, once the project has a coordinator. */
  coordinatorSessionKey?: string | null
  /** Whether the row's workspace has an open or draft pull or merge request. */
  hostedReviewOpen?: (row: SessionSidebarTreeRow) => boolean
  agentStatusByPaneKey?: Readonly<
    Record<
      string,
      | {
          model?: string
          updatedAt?: number
          orchestration?: { taskTitle?: string; parentPaneKey?: string }
        }
      | undefined
    >
  >
  /** The runtime's dispatch context by pane key; it can arrive before the worker's own report. */
  orchestrationByPaneKey?: Readonly<
    Record<string, { taskTitle?: string; parentPaneKey?: string } | undefined>
  >
  /** The task each conversation serves, by pane key (`useSessionTasks`). */
  taskLinkByPaneKey?: Readonly<Record<string, SessionTaskLink | undefined>>
}

/**
 * A project's threads: the rows filed anywhere in its folder subtree, the coordinator, and the
 * unfiled workers those rows dispatched. Workers are counted by lineage, not by where the sidebar
 * draws them: one that asks the person stops nesting there, yet it is still the project's thread.
 */
export function sessionProjectThreads<T extends SessionSidebarTreeRow>(
  folders: readonly SessionFolder[],
  rows: readonly T[],
  projectFolderId: string,
  inputs: SessionProjectThreadInputs = {}
): SessionProjectThread<T>[] {
  const subtree = sessionFolderSubtreeIds(folders, projectFolderId)
  const coordinatorKey = inputs.coordinatorSessionKey ?? null
  const isCoordinator = (row: T): boolean =>
    coordinatorKey !== null && conversationViewKey(row.session) === coordinatorKey
  const members = new Set<T>()
  const memberLeaves = new Set<string>()
  const rowsByLeaf = new Map<string, T[]>()
  for (const row of rows) {
    if (!row.session.paneKey) {
      continue
    }
    const leaf = paneLeafIdentity(row.session.paneKey)
    rowsByLeaf.set(leaf, [...(rowsByLeaf.get(leaf) ?? []), row])
  }
  const uniqueLeaf = (row: T): string | null => {
    if (!row.session.paneKey) {
      return null
    }
    const leaf = paneLeafIdentity(row.session.paneKey)
    return rowsByLeaf.get(leaf)?.length === 1 ? leaf : null
  }
  const add = (row: T): void => {
    members.add(row)
    const leaf = uniqueLeaf(row)
    if (leaf) {
      memberLeaves.add(leaf)
    }
  }
  for (const row of rows) {
    if ((row.folderId !== null && subtree.has(row.folderId)) || isCoordinator(row)) {
      add(row)
    }
  }
  const lineage = inputs.workerParentByLeaf
  const workers = lineage?.size
    ? rows.filter((row) => row.folderId === null && row.session.paneKey && !members.has(row))
    : []
  // Why repeat: a worker's own workers belong to the project too.
  for (let depth = 0; depth < MAX_LINEAGE_DEPTH && workers.length; depth++) {
    const joined = workers.filter((row) => {
      // A remembered leaf-only link cannot choose between copies on different hosts.
      const leaf = uniqueLeaf(row)
      const parent = leaf ? lineage!.get(leaf) : undefined
      return parent !== undefined && !members.has(row) && memberLeaves.has(parent)
    })
    if (!joined.length) {
      break
    }
    joined.forEach(add)
  }
  const sessionsPerWorkspace = new Map<string, number>()
  for (const row of rows) {
    const key = workspaceKey(row)
    sessionsPerWorkspace.set(key, (sessionsPerWorkspace.get(key) ?? 0) + 1)
  }
  const chatPaneKey = rows.find((row) => members.has(row) && isCoordinator(row))?.session.paneKey
  return rows
    .filter((row) => members.has(row))
    .map((row) => {
      const coordinator = isCoordinator(row)
      // Why only a lone session: threads sharing one checkout must not all wait on one review.
      const openReview =
        !coordinator && sessionsPerWorkspace.get(workspaceKey(row)) === 1
          ? inputs.hostedReviewOpen?.(row)
          : undefined
      const paneKey = row.session.paneKey
      const status = paneKey ? inputs.agentStatusByPaneKey?.[paneKey] : undefined
      const task = paneKey ? inputs.taskLinkByPaneKey?.[paneKey] : undefined
      const dispatch =
        (paneKey ? inputs.orchestrationByPaneKey?.[paneKey] : undefined) ?? status?.orchestration
      return {
        row,
        status: sessionProjectThreadStatus(
          row,
          inputs.classifications?.get(row.session.rowKey),
          openReview
        ),
        isCoordinator: coordinator,
        agent: row.session.agent,
        ...(status?.model ? { model: status.model } : {}),
        ...(row.session.hostId ? { host: row.session.hostId } : {}),
        ...(task?.workRef ? { jira: task.workRef } : {}),
        lastActivityAt: status?.updatedAt ?? null,
        ...(dispatch?.taskTitle?.trim()
          ? {
              origin: {
                task: dispatch.taskTitle.trim(),
                fromChat: Boolean(chatPaneKey && dispatch.parentPaneKey === chatPaneKey)
              }
            }
          : {})
      }
    })
}

function workspaceKey(row: SessionSidebarTreeRow): string {
  return JSON.stringify([row.session.hostId ?? 'local', row.session.worktreeId])
}

/** What the project page's filter bar selects; an empty or absent list allows every value. */
export type SessionProjectThreadFilter = {
  statuses?: readonly SessionProjectThreadStatus[]
  agents?: readonly string[]
  modelFamilies?: readonly ModelLineage[]
  hosts?: readonly ExecutionHostId[]
  /** Jira issue keys; `none` keeps the threads with no issue. */
  tasks?: readonly string[]
  includeArchived?: boolean
}

export function sessionProjectThreadModelFamily(thread: SessionProjectThread): ModelLineage {
  return modelLineage(thread.agent, thread.model)
}

export function filterSessionProjectThreads<T extends SessionSidebarTreeRow>(
  threads: readonly SessionProjectThread<T>[],
  filter: SessionProjectThreadFilter
): SessionProjectThread<T>[] {
  const allows = <V>(values: readonly V[] | undefined, value: V): boolean =>
    !values?.length || values.includes(value)
  return threads.filter(
    (thread) =>
      (filter.includeArchived || !thread.row.archived || thread.isCoordinator) &&
      (!filter.statuses?.length ||
        (thread.status !== null && filter.statuses.includes(thread.status))) &&
      allows(filter.agents, thread.agent) &&
      allows(filter.modelFamilies, sessionProjectThreadModelFamily(thread)) &&
      allows(filter.hosts, thread.host ?? 'local') &&
      allows(filter.tasks, thread.jira?.issue_key ?? 'none')
  )
}
