import type { WorkflowSpec } from '../../../shared/workflow-graph'
import {
  resolveLocalWorkflowSeat,
  type LocalWorkflowSeatCatalog,
  type LocalWorkflowSeatChoice,
  type ResolvedLocalWorkflowSeat
} from '../../../shared/local-workflow-seats'
import { localWorkflowProviderLabel } from '../../../shared/local-workflow-model-label'
import { workflowSeatCapacityNote } from '../../../shared/local-workflow-seat-capacity'
import type { GraphSeatFields } from './graph/graph-plan-types'
import { graphSpareSeatId, SEAT_RULES } from './graph/graph-seat-substitution'

/** Account ids that would break a spare seat's id or a substitute's call id. */
const UNSAFE_ACCOUNT_ID = /[~/@]/

/**
 * Seat rules frozen at admission (graph-seat-substitution.ts). The seats themselves are the
 * team's, untouched. Each also gets a spare on every other eligible account of its family, with
 * the same model and effort, verified now like any seat; a call that failed at launch may move
 * to one whose capacity is fresh then. A Claude or Codex seat whose account has no fresh
 * verified capacity is named, so the run's gaps say so.
 */
export function admitGraphSeatRules(
  seats: readonly ResolvedLocalWorkflowSeat[],
  catalog: readonly LocalWorkflowSeatCatalog[]
): GraphSeatFields {
  const spareSeats: ResolvedLocalWorkflowSeat[] = []
  const seatNotes: string[] = []
  for (const seat of seats) {
    const own = catalog.find(
      (entry) => entry.agent === seat.agent && entry.accountId === seat.accountId
    )
    if (seat.agent === 'claude' || seat.agent === 'codex') {
      const note = workflowSeatCapacityNote(
        localWorkflowProviderLabel(seat.agent),
        own?.accountLabel ?? seat.accountId,
        own?.capacity
      )
      if (note && !seatNotes.includes(note)) {
        seatNotes.push(note)
      }
    }
    const model = own?.models.find((entry) => entry.resolvedModelId === seat.model)?.catalog.id
    for (const other of catalog) {
      if (
        !model ||
        other.agent !== seat.agent ||
        other.accountId === seat.accountId ||
        other.unavailableReason ||
        UNSAFE_ACCOUNT_ID.test(other.accountId)
      ) {
        continue
      }
      try {
        spareSeats.push(
          resolveLocalWorkflowSeat(
            {
              id: graphSpareSeatId(seat.id, other.accountId),
              agent: seat.agent,
              accountId: other.accountId,
              model,
              ...(seat.effort ? { effort: seat.effort } : {})
            },
            catalog
          )
        )
      } catch {
        // An account that cannot run the seat's model and effort is no spare for it.
      }
    }
  }
  return { seatRules: SEAT_RULES, spareSeats, seatNotes }
}

/**
 * The seat an agent runs on: its family's team choice, with the agent's own model when it names
 * one. Seats are shared by every agent that resolves to the same choice.
 */
export function resolveGraphSeats(
  spec: WorkflowSpec,
  team: readonly LocalWorkflowSeatChoice[],
  catalog: readonly LocalWorkflowSeatCatalog[]
): { seats: ResolvedLocalWorkflowSeat[]; agentSeats: Record<string, string[]> } {
  const seats = new Map<string, ResolvedLocalWorkflowSeat>()
  const agentSeats: Record<string, string[]> = {}
  for (const step of spec.steps) {
    agentSeats[step.id] = step.agents.map((agent) => {
      const base = team.find((choice) => choice.agent === agent.route)
      if (!base) {
        throw new Error(`${step.title}: ${agent.route} is not set up on this computer.`)
      }
      const id = agent.model ? `${agent.route}:${agent.model}` : agent.route
      if (!seats.has(id)) {
        seats.set(
          id,
          resolveLocalWorkflowSeat(
            { ...base, id, ...(agent.model ? { model: agent.model, effort: undefined } : {}) },
            catalog
          )
        )
      }
      return id
    })
  }
  return { seats: [...seats.values()], agentSeats }
}
