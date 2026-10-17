import { isIndependentLineage } from '../../../../shared/model-lineage'
import type { ResolvedLocalWorkflowSeat } from '../../../../shared/local-workflow-seats'
import type { LocalWorkflowSeatCapacity } from '../../../../shared/local-workflow-seat-capacity'
import { localWorkflowProviderLabel } from '../../../../shared/local-workflow-model-label'
import {
  graphPlural,
  type GraphCall,
  type GraphConfig,
  type GraphDegraded,
  type GraphOutcome,
  type GraphRunOutcome,
  type GraphSeatFields,
  type GraphSubstitution
} from './graph-plan-types'
import type { GraphScope } from './graph-scope'

/**
 * Seat rules 2 adds cross-family failover for failed Discover Brief/Scout calls.
 * Seat rules 1: a call that failed at launch (workflow-launch-failure.ts) runs once more, on
 * another account of its family with fresh capacity, else on another family the step allows; a
 * call no seat could take is lost, and a run that lost calls is degraded. Older runs have no
 * rules and replay as they ran.
 */
export const SEAT_RULES = 2

/** Separates a planned call id from the seat its substitute ran on: `<call>~<seat>`. */
const SUBSTITUTE = '~'

export function graphSubstituteCallId(callId: string, seatId: string): string {
  return `${callId}${SUBSTITUTE}${seatId}`
}

/** The seat a substitute call ran on, or undefined for a planned call. */
export function graphSubstituteSeatId(callId: string): string | undefined {
  const at = callId.indexOf(SUBSTITUTE)
  return at === -1 ? undefined : callId.slice(at + 1)
}

/** A spare seat's id: its family seat's, then the account it runs on. */
export function graphSpareSeatId(seatId: string, accountId: string): string {
  return `${seatId}@${accountId}`
}

/** The seat rules a run was admitted under, read defensively: older snapshots have none. */
export function graphSeatRules(snapshot: object): GraphSeatFields {
  const graph = (snapshot as { graph?: GraphSeatFields }).graph
  if (typeof graph?.seatRules !== 'number') {
    return {}
  }
  return {
    seatRules: graph.seatRules,
    ...(Array.isArray(graph.spareSeats) ? { spareSeats: graph.spareSeats } : {}),
    ...(Array.isArray(graph.seatNotes) ? { seatNotes: graph.seatNotes } : {})
  }
}

function shortReason(failure: string): string {
  const reason = failure.replace(/^Workflow call exhausted its attempts:\s*/, '').trim()
  return reason.length > 160 ? `${reason.slice(0, 159)}…` : reason
}

/** How a gap names a move from one seat to another. */
export function graphSubstitution(
  callId: string,
  from: ResolvedLocalWorkflowSeat,
  to: ResolvedLocalWorkflowSeat,
  failure: string
): GraphSubstitution {
  const label = localWorkflowProviderLabel(to.agent)
  return {
    seatId: to.id,
    callId: graphSubstituteCallId(callId, to.id),
    from: localWorkflowProviderLabel(from.agent),
    to: to.agent === from.agent ? `another ${label} account` : label,
    reason: shortReason(failure)
  }
}

const freshCapacity = (capacity: LocalWorkflowSeatCapacity) =>
  capacity.state === 'fresh' && capacity.remainingPercent > 0

const usable = (capacity: LocalWorkflowSeatCapacity) =>
  capacity.state !== 'limited' && capacity.state !== 'signed-out'

/**
 * `GraphConfig.substitute` for one run. A substitute already recorded for the call is reused, so
 * recovery and replay move it the same way; otherwise only a live run (`capacity` given) picks
 * one: the spare account of the call's family with the most fresh capacity, else the first seat
 * of another family, from the step's own seats first, whose account is not known to be limited.
 * Gemini only ever finds, so it takes Do calls only. A seat that failed at launch is never picked.
 */
export function createGraphSeatSubstitute(input: {
  dispatched?: boolean
  config: Pick<GraphConfig, 'spec' | 'seats' | 'agentSeats' | 'spareSeats'>
  recorded?: () => readonly string[]
  capacity?: () => Promise<(seat: ResolvedLocalWorkflowSeat) => LocalWorkflowSeatCapacity>
}): NonNullable<GraphConfig['substitute']> {
  const { config } = input
  const all = [...config.seats, ...(config.spareSeats ?? [])]
  const seatOf = (id: string | undefined) => all.find((seat) => seat.id === id)
  const failedSeats = new Set<string>()
  return async (call: GraphCall, failure?: string, crossFamily = false) => {
    const original = seatOf(call.seatId)
    if (!original) {
      return undefined
    }
    const prefix = graphSubstituteCallId(call.id, '')
    const recorded = input.recorded?.().find((id) => id.startsWith(prefix))
    if (recorded) {
      const seat = seatOf(recorded.slice(prefix.length))
      return seat
        ? graphSubstitution(call.id, original, seat, failure ?? 'it could not start')
        : undefined
    }
    if (!failure || !input.capacity) {
      return undefined
    }
    failedSeats.add(original.id)
    const capacityOf = await input.capacity()
    const spare = (input.dispatched ? [] : (config.spareSeats ?? []))
      .filter((seat) => seat.id.startsWith(`${original.id}@`) && !failedSeats.has(seat.id))
      .flatMap((seat) => {
        const capacity = capacityOf(seat)
        return capacity.state === 'fresh' && capacity.remainingPercent > 0
          ? [{ seat, remaining: capacity.remainingPercent }]
          : []
      })
      .sort((a, b) => b.remaining - a.remaining || a.seat.id.localeCompare(b.seat.id))[0]
    if (spare && !crossFamily) {
      return graphSubstitution(call.id, original, spare.seat, failure)
    }
    const kind = config.spec.steps.find((step) => step.id === call.stepId)?.kind
    const order = [
      ...(config.agentSeats[call.stepId] ?? []),
      ...config.seats.map((seat) => seat.id)
    ]
    const other = [...new Set(order)].map(seatOf).find(
      (seat): seat is ResolvedLocalWorkflowSeat =>
        !!seat &&
        // A seat id with `/` or `~` would break the substitute's call id.
        !/[~/]/.test(seat.id) &&
        (crossFamily
          ? isIndependentLineage(seat.lineage, original.lineage)
          : seat.agent !== original.agent) &&
        (!input.dispatched || seat.agent === 'claude' || seat.agent === 'codex') &&
        !failedSeats.has(seat.id) &&
        (seat.agent !== 'gemini' || kind === 'do') &&
        (crossFamily ? freshCapacity(capacityOf(seat)) : usable(capacityOf(seat)))
    )
    return other ? graphSubstitution(call.id, original, other, failure) : undefined
  }
}

type Tally = { count: number; reason: string }

function tally(groups: Map<string, Tally>, key: string, reason: string): void {
  const entry = groups.get(key)
  if (entry) {
    entry.count++
  } else {
    groups.set(key, { count: 1, reason })
  }
}

/**
 * The run's seat gaps: accounts not verified at the start, calls moved after a launch failure,
 * and calls lost for good. A run that lost any is degraded, whatever its final step produced.
 */
export function graphSeatOutcome(scope: GraphScope, outcome: GraphRunOutcome): GraphRunOutcome {
  const { config } = scope
  if (config.seatRules === undefined) {
    return outcome
  }
  const gaps = [...(config.seatNotes ?? [])]
  let lostCalls = 0
  const steps: string[] = []
  for (const step of config.spec.steps) {
    const moved = new Map<string, Tally>()
    const lost = new Map<string, Tally>()
    for (const call of scope.calls) {
      const settled: GraphOutcome | undefined =
        call.stepId === step.id ? scope.outcomes.get(call.id) : undefined
      if (settled && 'value' in settled && settled.substitute) {
        const { from, to, reason } = settled.substitute
        tally(moved, `${from}\n${to}`, reason)
      } else if (settled && 'failed' in settled && settled.lost) {
        tally(lost, '', settled.lost)
      }
    }
    for (const [key, entry] of moved) {
      const [from, to] = key.split('\n')
      gaps.push(
        `${step.title}: ${graphPlural(entry.count, 'call')} ${config.spec.template === 'discover' && (step.id === 'brief' || step.id === 'scout') && (config.seatRules ?? 0) >= 2 ? 'did not return an accepted result on' : 'could not start on'} ${from} (${entry.reason}) and ran on ${to} instead.`
      )
    }
    const gone = lost.get('')
    if (gone) {
      lostCalls += gone.count
      steps.push(step.title)
      gaps.push(
        `${step.title}: ${graphPlural(gone.count, 'call')} lost. ${gone.count === 1 ? 'It' : 'They'} could not start (${shortReason(gone.reason)}), and no other account or model family could take ${gone.count === 1 ? 'it' : 'them'}.`
      )
    }
  }
  const degraded: GraphDegraded | undefined = lostCalls ? { lostCalls, steps } : undefined
  return {
    ...outcome,
    gaps: [...gaps, ...outcome.gaps],
    ...(degraded ? { degraded } : {})
  }
}

/** A live run's account capacity now, freshened first (the host's readings). */
export type GraphSeatCapacity = () => Promise<
  (seat: ResolvedLocalWorkflowSeat) => LocalWorkflowSeatCapacity
>

/**
 * The seat fields and `substitute` of a run's GraphConfig: none before seat rules. Only a live
 * run given the host's capacity readings picks new substitutes; replays reuse recorded ones.
 */
export function graphSeatConfig(
  snapshot: {
    seats: ResolvedLocalWorkflowSeat[]
    graph: Pick<GraphConfig, 'spec' | 'agentSeats'>
    host?: unknown
  },
  graph: {
    jev?: { cacheOnly?: boolean }
    recorded?: () => readonly string[]
    seatCapacity?: GraphSeatCapacity
  }
): Partial<GraphConfig> {
  const rules = graphSeatRules(snapshot)
  if (rules.seatRules === undefined) {
    return {}
  }
  const config = {
    spec: snapshot.graph.spec,
    seats: snapshot.seats,
    agentSeats: snapshot.graph.agentSeats,
    ...(rules.spareSeats ? { spareSeats: rules.spareSeats } : {})
  }
  const live = !!graph.jev && !graph.jev.cacheOnly
  return {
    ...rules,
    substitute: createGraphSeatSubstitute({
      config,
      dispatched:
        (snapshot.host as { placement?: { mode: string } } | undefined)?.placement?.mode ===
        'dispatched-seats',
      ...(graph.recorded ? { recorded: graph.recorded } : {}),
      ...(live && graph.seatCapacity ? { capacity: graph.seatCapacity } : {})
    })
  }
}

/** A limit hit on any call immediately removes that seat from later substitution choices. */
export function graphAvailableSeatCapacity(
  capacity: GraphSeatCapacity,
  failures: Map<string, string>
): GraphSeatCapacity {
  return async () => {
    const reading = await capacity()
    return (seat) => (failures.has(seat.id) ? { state: 'limited' } : reading(seat))
  }
}
