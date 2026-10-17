import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type {
  SessionProjectListEntry,
  SessionProjectListResult,
  SessionProjectThreadCounts
} from '../../shared/session-project-cli'

/**
 * This computer's projects with their threads counted as each page counts them (upgrade plan
 * PR 6). A paired desktop lists them to dispatch into one; nothing here changes a project.
 */

export const PROJECT_LIST_OLDER_WINDOW =
  'Listing projects requires an updated OmniConsole window. Reload the app and try again.'

export type ProjectListRuntime = {
  requestSessionFolders(request: { kind: 'listProjects' }): Promise<unknown>
  /** The sidebar rows with that project's threads marked (`projectThread`). */
  readProjectRows(projectFolderId: string): Promise<SessionManageSidebarRow[]>
}

/** The same rows `omni session list --project` lists: no folded panes, archived only for the chat. */
export function projectThreadCounts(
  rows: readonly SessionManageSidebarRow[]
): SessionProjectThreadCounts {
  const counts: SessionProjectThreadCounts = { total: 0, byStatus: {} }
  for (const row of rows) {
    const thread = row.projectThread
    if (!thread || row.folded || (row.archived && !thread.coordinator)) {
      continue
    }
    const status = thread.status ?? 'idle'
    if (thread.coordinator) {
      counts.chat = status
      continue
    }
    counts.total += 1
    counts.byStatus[status] = (counts.byStatus[status] ?? 0) + 1
  }
  return counts
}

type WindowProject = Omit<SessionProjectListEntry, 'threads'>

function windowProjects(answer: unknown): WindowProject[] {
  // Why: an older window answers a kind it doesn't know with nothing.
  if (!answer || typeof answer !== 'object' || !Array.isArray((answer as never)['projects'])) {
    throw new Error(PROJECT_LIST_OLDER_WINDOW)
  }
  return (answer as { projects: WindowProject[] }).projects
}

export async function listSessionProjects(
  runtime: ProjectListRuntime
): Promise<SessionProjectListResult> {
  const projects = windowProjects(await runtime.requestSessionFolders({ kind: 'listProjects' }))
  const listed: SessionProjectListEntry[] = []
  // Why one at a time: each read builds the whole sidebar in the window.
  for (const project of projects) {
    const rows = await runtime.readProjectRows(project.folderId).catch(() => null)
    listed.push({ ...project, threads: rows ? projectThreadCounts(rows) : null })
  }
  return { projects: listed }
}
