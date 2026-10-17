import { makePaneKey } from '../../shared/stable-pane-id'
import { isWebTerminalSurfaceTabId } from '../../shared/terminal-surface-id'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

type PersistedTerminalSurfaceBinding = {
  worktreeId: string
  tabId: string
  paneKey: string
  incarnationId: string
}

type Candidate = PersistedTerminalSurfaceBinding & { leafId: string; grouped: boolean }

function selectSurface(candidates: Candidate[]): Candidate | undefined {
  const first = candidates[0]
  if (!first) {
    return undefined
  }
  if (
    candidates.every(
      (candidate) =>
        candidate.worktreeId === first.worktreeId &&
        candidate.paneKey === first.paneKey &&
        candidate.incarnationId === first.incarnationId
    )
  ) {
    return first
  }
  const grouped = candidates.filter((candidate) => candidate.grouped)
  const owner = grouped.length === 1 ? grouped[0] : undefined
  if (!owner || isWebTerminalSurfaceTabId(owner.tabId)) {
    return undefined
  }
  // A saved host group disambiguates exact ungrouped duplicates (web mirrors or stale host rows).
  return candidates.every(
    (candidate) =>
      candidate === owner ||
      (!candidate.grouped &&
        candidate.worktreeId === owner.worktreeId &&
        candidate.leafId === owner.leafId &&
        candidate.incarnationId === owner.incarnationId)
  )
    ? owner
    : undefined
}

export function indexPersistedPtySurfaceBindings(
  session: WorkspaceSessionState | null | undefined
): ReadonlyMap<string, PersistedTerminalSurfaceBinding> {
  const candidatesByPtyId = new Map<string, Candidate[]>()
  for (const [worktreeId, tabs] of Object.entries(session?.tabsByWorktree ?? {})) {
    const groupedTabIds = new Set(
      session?.tabGroups?.[worktreeId]?.flatMap((group) => group.tabOrder) ?? []
    )
    for (const tab of tabs) {
      for (const [leafId, ptyId] of Object.entries(
        session?.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {}
      )) {
        if (!ptyId) {
          continue
        }
        const paneKey = makePaneKey(tab.id, leafId)
        const incarnationId = session?.terminalPtyIncarnationsByPaneKey?.[paneKey]
        if (!incarnationId) {
          continue
        }
        const candidates = candidatesByPtyId.get(ptyId) ?? []
        candidates.push({
          worktreeId,
          tabId: tab.id,
          paneKey,
          incarnationId,
          leafId,
          grouped: groupedTabIds.has(tab.id)
        })
        candidatesByPtyId.set(ptyId, candidates)
      }
    }
  }
  const bindings = new Map<string, PersistedTerminalSurfaceBinding>()
  for (const [ptyId, candidates] of candidatesByPtyId) {
    const surface = selectSurface(candidates)
    if (surface && !session?.terminalSurfaceTombstonesByPaneKey?.[surface.paneKey]) {
      const { worktreeId, tabId, paneKey, incarnationId } = surface
      bindings.set(ptyId, { worktreeId, tabId, paneKey, incarnationId })
    }
  }
  return bindings
}
