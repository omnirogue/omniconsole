import type { WorkflowStep } from '../../../../shared/workflow-graph'
import type { GraphConfig } from './graph-plan-types'

/** The frontier seats a run pinned at admission (graph.frontierSeats), read defensively. */
export function graphImproveFrontierSeats(
  snapshot: object
): Pick<GraphConfig, 'improveFrontierSeats'> {
  const seats = (snapshot as { graph?: { frontierSeats?: unknown } }).graph?.frontierSeats
  return Array.isArray(seats) && seats.every((seat) => typeof seat === 'string')
    ? { improveFrontierSeats: seats as string[] }
    : {}
}

/**
 * The seat each improver runs on in a frontier round, where it differs from its own frozen seat.
 * Undefined when no improver would change model: no frontier seats were pinned, or every improver
 * already runs its family's frontier model. Only seats the run admitted are ever used.
 */
export function graphImproveFrontier(
  config: Pick<GraphConfig, 'seats' | 'agentSeats' | 'improveFrontierSeats'>,
  doStep: WorkflowStep
): (string | undefined)[] | undefined {
  const frontier = config.improveFrontierSeats
  if (!frontier) {
    return undefined
  }
  const own = config.agentSeats[doStep.id] ?? []
  const admitted = new Set(config.seats.map((seat) => seat.id))
  const moves = doStep.agents.map((_, index) => {
    const seat = frontier[index]
    return seat && seat !== own[index] && admitted.has(seat) ? seat : undefined
  })
  return moves.some(Boolean) ? moves : undefined
}

/** The seat an Improve improver's frontier call (`step/rN/f<agent>`) ran on. */
export function graphImproveFrontierCallSeat(
  frontierSeats: readonly string[] | undefined,
  callId: string
): string | undefined {
  const agent = /\/f(\d+)$/.exec(callId)
  return agent ? frontierSeats?.[Number(agent[1])] : undefined
}
