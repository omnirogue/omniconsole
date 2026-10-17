import type { SessionActionPresetId } from './session-action-presets'
import type { LocalRunGraph, LocalRunNode } from './local-run-graph'

/**
 * What one node of a local Run is doing, derived from stored rows only. The names
 * that overlap the hub flow vocabulary mean the same thing there: QUEUED is admitted
 * and not started, RUNNING has a live worker, COMPLETED and FAILED are terminal.
 */
export type LocalRunNodeState =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'reviewing'
  | 'needs-input'
  | 'completed'
  | 'failed'

export const LOCAL_RUN_NODE_STATES: readonly LocalRunNodeState[] = [
  'queued',
  'running',
  'waiting',
  'reviewing',
  'needs-input',
  'completed',
  'failed'
]

/** Presets that read and report; they never edit the workspace. */
export const LOCAL_RUN_READ_ONLY_PRESETS: readonly SessionActionPresetId[] = [
  'research',
  'analyze',
  'plan',
  'verify',
  'review'
]

/** Presets whose live worker is reviewing rather than producing. */
const REVIEWING_PRESETS: readonly SessionActionPresetId[] = ['verify', 'review']

export function isLocalRunEditingPreset(presetId: SessionActionPresetId): boolean {
  return !LOCAL_RUN_READ_ONLY_PRESETS.includes(presetId)
}

/** Lifecycle of the worker Dispatch this node was executed through. */
export type LocalRunDispatchStatus =
  | 'pending'
  | 'dispatched'
  | 'completed'
  | 'failed'
  | 'circuit_broken'

export type LocalRunNodeRows = {
  /** orchestration task status for this node's Task. */
  taskStatus: 'pending' | 'ready' | 'dispatched' | 'completed' | 'failed' | 'blocked' | null
  /**
   * Status of this node's worker Dispatch, or null before one exists. A dispatch that
   * is `pending` or `dispatched` means an agent is executing this node RIGHT NOW.
   */
  dispatchStatus: LocalRunDispatchStatus | null
  /** A decision gate row on this Task is still pending. */
  pendingGate: boolean
  /** This node's worker asked a question nobody has answered. */
  openQuestion: boolean
  presetId: SessionActionPresetId
}

function executingState(presetId: SessionActionPresetId): LocalRunNodeState {
  return REVIEWING_PRESETS.includes(presetId) ? 'reviewing' : 'running'
}

/**
 * NEEDS INPUT beats everything: an unanswered gate or question is the one state a
 * person has to act on, and hiding it behind RUNNING is how a Run silently stalls.
 *
 * Why the Dispatch row outranks the Task row: the local runner takes a Task off
 * `taskList {ready}` and starts the worker itself, and only the LLM coordinator loop
 * — which a local run deliberately does not have — moves a Task row to `dispatched`.
 * Reading the Task row alone showed a node with a live worker, a running dispatch and
 * heartbeats in its event log as QUEUED for the whole node (live run lrn_0ab7ec63666e,
 * 2026-09-10).
 */
export function deriveLocalRunNodeState(rows: LocalRunNodeRows): LocalRunNodeState {
  if (rows.pendingGate || rows.openQuestion) {
    return 'needs-input'
  }
  if (rows.taskStatus === 'completed') {
    return 'completed'
  }
  if (rows.taskStatus === 'failed') {
    return 'failed'
  }
  if (rows.dispatchStatus === 'pending' || rows.dispatchStatus === 'dispatched') {
    return executingState(rows.presetId)
  }
  switch (rows.taskStatus) {
    case 'dispatched':
      return executingState(rows.presetId)
    case 'blocked':
      // Blocked with no pending gate: a dependency can no longer be satisfied, or a
      // resolved gate has not been promoted yet. Either way nothing is executing.
      return 'waiting'
    case 'pending':
    case 'ready':
    case null:
      return 'queued'
  }
  // Why after the switch and not a `default:` case: the union above is exhaustive, so a
  // default is dead to the type checker. The status still arrives from SQLite, and a row
  // written by a newer schema must land on the state that asks nothing of the person.
  return 'queued'
}

/**
 * Topological depth per node. Nodes that share a depth can be ready at the same
 * moment, which is what decides whether a node needs its own isolated workspace.
 */
export function localRunNodeLevels(graph: LocalRunGraph): Map<string, number> {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const levels = new Map<string, number>()
  const levelOf = (id: string, seen: Set<string>): number => {
    const known = levels.get(id)
    if (known !== undefined) {
      return known
    }
    if (seen.has(id)) {
      return 0
    }
    seen.add(id)
    const deps = byId.get(id)?.deps ?? []
    const level = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((dep) => levelOf(dep, seen)))
    levels.set(id, level)
    return level
  }
  for (const node of graph.nodes) {
    levelOf(node.id, new Set())
  }
  return levels
}

/** Nodes that can be dispatched simultaneously with at least one sibling. */
export function localRunParallelNodeIds(graph: LocalRunGraph): Set<string> {
  const levels = localRunNodeLevels(graph)
  const counts = new Map<number, number>()
  for (const level of levels.values()) {
    counts.set(level, (counts.get(level) ?? 0) + 1)
  }
  const parallel = new Set<string>()
  for (const [id, level] of levels) {
    if ((counts.get(level) ?? 0) > 1) {
      parallel.add(id)
    }
  }
  return parallel
}

/** Nodes in dependency order, with the ones that can run together kept adjacent. */
export function localRunNodesInLevelOrder(graph: LocalRunGraph): LocalRunNode[] {
  const levels = localRunNodeLevels(graph)
  return [...graph.nodes].sort(
    (a, b) => (levels.get(a.id) ?? 0) - (levels.get(b.id) ?? 0) || a.id.localeCompare(b.id)
  )
}
