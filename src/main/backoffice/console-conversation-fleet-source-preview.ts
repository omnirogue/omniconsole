import { isDeepStrictEqual } from 'node:util'
import type { ConsoleConversationFleetPreviewRequest } from '../../shared/console-conversation-fleet-types'
import type { ConsoleWorkflowGraph, ConsoleWorkflowNode } from '../../shared/console-workflow-types'

function appliesSourceOverlay(node: ConsoleWorkflowNode, graph: ConsoleWorkflowGraph): boolean {
  const seen = new Set<string>()
  const pending = [...node.after]
  while (pending.length > 0) {
    const key = pending.pop()!
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    const prior = graph.nodes.find((candidate) => candidate.key === key)
    if (!prior) {
      return false
    }
    const sameWorkspace = node.workspace
      ? isDeepStrictEqual(prior.workspace, node.workspace)
      : prior.repo === node.repo
    if (
      prior.actor_type === 'ai' &&
      ['execute', 'repair'].includes(prior.action) &&
      sameWorkspace
    ) {
      return false
    }
    pending.push(...prior.after)
  }
  return true
}

export function matchesConversationFleetSources(
  input: ConsoleConversationFleetPreviewRequest,
  graph: ConsoleWorkflowGraph
): boolean {
  const files = input.sourceFiles ?? []
  const deletions = input.sourceDeletions ?? []
  const hasSource = files.length > 0 || deletions.length > 0
  return graph.nodes.every((node) =>
    node.actor_type === 'ai'
      ? isDeepStrictEqual(node.source_files ?? [], files) &&
        isDeepStrictEqual(node.source_deletions ?? [], deletions) &&
        node.source_overlay === (hasSource ? appliesSourceOverlay(node, graph) : undefined)
      : node.source_files === undefined &&
        node.source_deletions === undefined &&
        node.source_overlay === undefined
  )
}
