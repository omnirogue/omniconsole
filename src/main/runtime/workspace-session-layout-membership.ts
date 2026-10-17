import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode
} from '../../shared/terminal-tab-types'

export function collectLeafIds(node: TerminalPaneLayoutNode | null, ids: Set<string>): void {
  if (!node) {
    return
  }
  if (node.type === 'leaf') {
    ids.add(node.leafId)
    return
  }
  collectLeafIds(node.first, ids)
  collectLeafIds(node.second, ids)
}

export function layoutHasSameMembership(
  candidate: TerminalLayoutSnapshot,
  current: TerminalLayoutSnapshot
): boolean {
  const candidateIds = new Set<string>()
  const currentIds = new Set<string>()
  collectLeafIds(candidate.root, candidateIds)
  collectLeafIds(current.root, currentIds)
  return (
    candidateIds.size === currentIds.size &&
    [...candidateIds].every((leafId) => currentIds.has(leafId))
  )
}
