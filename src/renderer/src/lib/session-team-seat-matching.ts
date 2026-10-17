import type { ConsoleWorkflowNode } from '../../../shared/console-workflow-types'
import {
  isSessionChainAgentStep,
  type SessionChain,
  type SessionChainAgentStep
} from '../../../shared/session-chain-types'

/** Where a seat sits on a review loop: a reviewer, the repair after a round, or ordinary work. */
type SessionSeatKind = 'review' | 'repair' | 'work'

/** The compiled step behind a graph node, and whether another seat could hold it just as well. */
export type SessionSeatAssignment = {
  step: SessionChainAgentStep
  /** No recorded field separates this seat from another, so its title names nobody. */
  ambiguous: boolean
}

/** `loop_stage` is untyped JSON: a round may arrive as any JSON value. */
export function workflowNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function workflowText(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** A node names its stage; without one, its own key is the stage's. */
export function nodeStageKey(node: ConsoleWorkflowNode): string {
  return workflowText(node.loop_stage?.stage_key) ?? node.key
}

function nodeSeatKind(node: ConsoleWorkflowNode): SessionSeatKind {
  const role = node.loop_stage?.role
  if (role === 'repair') {
    return 'repair'
  }
  return role === 'participant' || role === 'reviewer' ? 'review' : 'work'
}

/** Why: a repair step shares its producer's provider and model, so only the route tells them apart. */
function stepSeatKind(step: SessionChainAgentStep): SessionSeatKind {
  return step.review ? 'review' : step.reviewRepair ? 'repair' : 'work'
}

/** A repair names the round it follows, so it is a rounded step like the review before it. */
function stepRound(step: SessionChainAgentStep): number | null {
  return step.round?.index ?? step.review?.round ?? step.reviewRepair?.afterRound ?? null
}

function nodeAgent(node: ConsoleWorkflowNode): string | null {
  return node.agent ?? node.provider ?? null
}

/**
 * How many recorded fields the two sides agree on, or null when one of them conflicts.
 * A field only one side recorded neither binds the pair nor refuses it, so it scores nothing:
 * a constrained pair always outranks an underspecified one competing for the same step.
 */
function seatSpecificity(node: ConsoleWorkflowNode, step: SessionChainAgentStep): number | null {
  if (nodeSeatKind(node) !== stepSeatKind(step)) {
    return null
  }
  const agent = nodeAgent(node)
  const round = workflowNumber(node.loop_stage?.round)
  const stepsRound = stepRound(step)
  const model = node.model ?? null
  const stepModel = step.model ?? null
  let specificity = 0
  if (agent !== null) {
    if (agent !== step.agent) {
      return null
    }
    specificity += 1
  }
  if (round !== null && stepsRound !== null) {
    if (round !== stepsRound) {
      return null
    }
    specificity += 1
  }
  if (model !== null && stepModel !== null) {
    if (model !== stepModel) {
      return null
    }
    specificity += 1
  }
  return specificity
}

/** Agreement counts, most constrained first, so every seat is tried on its own terms first. */
const SEAT_SPECIFICITY_TIERS = [3, 2, 1, 0] as const

type SeatEdges = ReadonlyMap<number, ReadonlyMap<number, number>>

/**
 * Kuhn's augmenting path restricted to edges of at least `tier`, so a seat arriving later can
 * displace an earlier one that had another option instead of being left unbound.
 */
function claimStep(
  nodeIndex: number,
  tier: number,
  edges: SeatEdges,
  ownerByStep: Map<number, number>,
  visited: Set<number>
): boolean {
  const options = edges.get(nodeIndex)
  if (!options) {
    return false
  }
  for (const [stepIndex, specificity] of options) {
    if (specificity < tier || visited.has(stepIndex)) {
      continue
    }
    visited.add(stepIndex)
    const owner = ownerByStep.get(stepIndex)
    if (owner === undefined || claimStep(owner, tier, edges, ownerByStep, visited)) {
      ownerByStep.set(stepIndex, nodeIndex)
      return true
    }
  }
  return false
}

function seatEdges(
  indexes: readonly number[],
  nodes: readonly ConsoleWorkflowNode[],
  steps: readonly SessionChainAgentStep[]
): SeatEdges {
  const edges = new Map<number, Map<number, number>>()
  for (const index of indexes) {
    const options = new Map<number, number>()
    steps.forEach((step, stepIndex) => {
      const specificity = seatSpecificity(nodes[index]!, step)
      if (specificity !== null) {
        options.set(stepIndex, specificity)
      }
    })
    edges.set(index, options)
  }
  return edges
}

/**
 * A seat keeps its title only when nothing else fits its step equally well: no free step it could
 * hold instead, and no other seat it could swap with at the same total agreement.
 */
function ambiguousNodes(
  stepByNode: ReadonlyMap<number, number>,
  freeSteps: readonly number[],
  edges: SeatEdges
): Set<number> {
  const ambiguous = new Set<number>()
  for (const [node, step] of stepByNode) {
    const held = edges.get(node)?.get(step) ?? 0
    if (freeSteps.some((free) => edges.get(node)?.get(free) === held)) {
      ambiguous.add(node)
    }
    for (const [otherNode, otherStep] of stepByNode) {
      const swapped = edges.get(node)?.get(otherStep)
      const otherSwapped = edges.get(otherNode)?.get(step)
      const otherHeld = edges.get(otherNode)?.get(otherStep) ?? 0
      if (
        otherNode !== node &&
        swapped !== undefined &&
        otherSwapped !== undefined &&
        swapped + otherSwapped === held + otherHeld
      ) {
        ambiguous.add(node)
        ambiguous.add(otherNode)
      }
    }
  }
  return ambiguous
}

/** The plan's compiled steps per stage key, in the stage's own order. */
function stepsByStageKey(chain: SessionChain | null): Map<string, SessionChainAgentStep[]> {
  const byId = new Map(
    (chain?.steps ?? []).filter(isSessionChainAgentStep).map((step) => [step.id, step])
  )
  const index = new Map<string, SessionChainAgentStep[]>()
  for (const stage of chain?.outcomeSet?.workflow?.stages ?? []) {
    const steps = stage.stepIds.flatMap((id) => {
      const step = byId.get(id)
      return step ? [step] : []
    })
    if (steps.length > 0) {
      index.set(stage.key, steps)
    }
  }
  return index
}

/** Binds one stage's nodes to its steps, one step per seat, and names only unambiguous seats. */
function pairStageSeats(
  indexes: readonly number[],
  nodes: readonly ConsoleWorkflowNode[],
  steps: readonly SessionChainAgentStep[],
  assigned: Map<number, SessionSeatAssignment>
): void {
  const edges = seatEdges(indexes, nodes, steps)
  const ownerByStep = new Map<number, number>()
  const matched = new Set<number>()
  for (const tier of SEAT_SPECIFICITY_TIERS) {
    for (const index of indexes) {
      if (!matched.has(index) && claimStep(index, tier, edges, ownerByStep, new Set())) {
        matched.add(index)
      }
    }
  }
  const stepByNode = new Map([...ownerByStep].map(([step, node]) => [node, step]))
  const freeSteps = steps.flatMap((_step, index) => (ownerByStep.has(index) ? [] : [index]))
  const ambiguous = ambiguousNodes(stepByNode, freeSteps, edges)
  for (const [node, step] of stepByNode) {
    assigned.set(node, { step: steps[step]!, ambiguous: ambiguous.has(node) })
  }
}

/**
 * The compiled step behind each graph node, keyed by the node's position in `nodes`.
 * A node with no step of its own stays unbound rather than borrowing another seat's state.
 */
export function assignStepsToNodes(
  nodes: readonly ConsoleWorkflowNode[],
  chain: SessionChain | null
): Map<number, SessionSeatAssignment> {
  const stages = stepsByStageKey(chain)
  const indexesByStage = new Map<string, number[]>()
  nodes.forEach((node, index) => {
    const key = nodeStageKey(node)
    indexesByStage.set(key, [...(indexesByStage.get(key) ?? []), index])
  })
  const assigned = new Map<number, SessionSeatAssignment>()
  for (const [stageKey, indexes] of indexesByStage) {
    pairStageSeats(indexes, nodes, stages.get(stageKey) ?? [], assigned)
  }
  return assigned
}
