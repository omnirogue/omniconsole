import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { WorktreeLineage } from '../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../shared/worktree/types'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'

export type SessionWorktreeLink = {
  id: string
  name: string
  branch: string | null
  path: string | null
  relation: 'own' | 'created' | 'worker'
  folder: boolean
}

export type SessionWorktreesInput = {
  sessionWorktreeId: string | null
  entry: AgentStatusEntry | null
  orchestrationChildren: readonly AgentStatusEntry[]
  lineageById: Readonly<Record<string, WorktreeLineage>>
  worktreesByRepo: Readonly<Record<string, readonly Worktree[]>>
  folderWorkspaces: readonly FolderWorkspace[]
}

function shortBranch(branch: string | null | undefined): string | null {
  return branch ? branch.replace(/^refs\/heads\//, '') : null
}

function resolveWorkspace(
  id: string,
  input: SessionWorktreesInput,
  worktreesById: ReadonlyMap<string, Worktree>
): Omit<SessionWorktreeLink, 'relation'> {
  const scope = parseWorkspaceKey(id)
  if (scope?.type === 'folder') {
    const folder = input.folderWorkspaces.find((item) => item.id === scope.folderWorkspaceId)
    return {
      id,
      name: folder?.name ?? id,
      branch: null,
      path: folder?.folderPath ?? null,
      folder: true
    }
  }
  const worktree = worktreesById.get(scope?.type === 'worktree' ? scope.worktreeId : id)
  return {
    id,
    name: worktree?.displayName || id,
    branch: shortBranch(worktree?.branch),
    path: worktree?.path ?? null,
    folder: false
  }
}

/** The session's own workspace, worktrees its terminal created, and workspaces its workers run in. */
export function selectSessionWorktrees(input: SessionWorktreesInput): SessionWorktreeLink[] {
  const worktreesById = new Map<string, Worktree>()
  for (const worktrees of Object.values(input.worktreesByRepo)) {
    for (const worktree of worktrees) {
      worktreesById.set(worktree.id, worktree)
    }
  }
  const links = new Map<string, SessionWorktreeLink>()
  const add = (id: string | null | undefined, relation: SessionWorktreeLink['relation']) => {
    if (id && !links.has(id)) {
      links.set(id, {
        ...resolveWorkspace(id, input, worktreesById),
        relation
      })
    }
  }
  add(input.sessionWorktreeId ?? input.entry?.worktreeId, 'own')
  const handle = input.entry?.terminalHandle
  const runId = input.entry?.orchestration?.orchestrationRunId
  for (const lineage of Object.values(input.lineageById)) {
    // Why: a child terminal's handle legitimately differs from its coordinator's; the run id alone binds it.
    const createdHere =
      (handle &&
        (lineage.createdByTerminalHandle === handle || lineage.coordinatorHandle === handle)) ||
      (runId && lineage.orchestrationRunId === runId)
    if (createdHere) {
      add(lineage.worktreeId, 'created')
    }
  }
  for (const child of input.orchestrationChildren) {
    add(child.worktreeId, 'worker')
  }
  return [...links.values()]
}

export function selectOrchestrationChildren(
  statusByPaneKey: Readonly<Record<string, AgentStatusEntry>>,
  paneKey: string | null
): AgentStatusEntry[] {
  if (!paneKey) {
    return []
  }
  return Object.values(statusByPaneKey).filter(
    (entry) => entry.paneKey !== paneKey && entry.orchestration?.parentPaneKey === paneKey
  )
}
