import {
  resolveLocalWorkflowSeat,
  type LocalWorkflowSeatCatalog,
  type LocalWorkflowSeatChoice,
  type ResolvedLocalWorkflowSeat
} from '../../../shared/local-workflow-seats'
import type { WorkflowSpec } from '../../../shared/workflow-graph'

/**
 * Improve's frontier seats (repeat.frontier), verified now like every other seat: each improver
 * moves to its family's frontier model on the team's account for that family. An improver keeps
 * its own seat when its family has no frontier model, the model cannot be verified on that
 * account, or it already runs that model. Absent `frontierSeats` when no improver would move, so
 * such a run is admitted exactly as before.
 */
export function admitImproveFrontierSeats(
  spec: WorkflowSpec,
  team: readonly LocalWorkflowSeatChoice[],
  catalog: readonly LocalWorkflowSeatCatalog[],
  resolved: { seats: ResolvedLocalWorkflowSeat[]; agentSeats: Record<string, string[]> }
): { seats: ResolvedLocalWorkflowSeat[]; frontierSeats?: string[] } {
  const repeat = spec.repeat
  const doStep = spec.steps.find((step) => step.id === repeat?.do)
  if (repeat?.until !== 'plateau' || !repeat.frontier?.length || !doStep) {
    return { seats: resolved.seats }
  }
  const known = new Map(resolved.seats.map((seat) => [seat.id, seat]))
  const own = resolved.agentSeats[doStep.id] ?? []
  const frontierSeats = doStep.agents.map((agent, index) => {
    const current = known.get(own[index]!)
    const target = repeat.frontier!.find((entry) => entry.route === agent.route)
    const base = team.find((choice) => choice.agent === agent.route)
    if (!current || !target?.model || !base) {
      return own[index]!
    }
    const id = `${target.route}:${target.model}`
    if (!known.has(id)) {
      try {
        known.set(
          id,
          resolveLocalWorkflowSeat({ ...base, id, model: target.model, effort: undefined }, catalog)
        )
      } catch {
        // A frontier model this account cannot verify is no frontier seat: the improver stays.
        return own[index]!
      }
    }
    const seat = known.get(id)!
    return seat.agent === current.agent && seat.model === current.model ? own[index]! : id
  })
  if (frontierSeats.every((id, index) => id === own[index])) {
    return { seats: resolved.seats }
  }
  const added = [...new Set(frontierSeats)].filter(
    (id) => !resolved.seats.some((seat) => seat.id === id)
  )
  return {
    seats: [...resolved.seats, ...added.map((id) => known.get(id)!)],
    frontierSeats
  }
}
