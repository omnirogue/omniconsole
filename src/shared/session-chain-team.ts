import type {
  SessionChain,
  SessionChainAgentStep,
  SessionChainStepRole,
  SessionChainTeamPlanning
} from './session-chain-types'
import type { TuiAgent } from './tui-agent'

/** One planned seat: every round of a reviewer, or every repair of one review, collapses into it. */
export type SessionChainTeamSeat = {
  key: string
  role: SessionChainStepRole
  agent: TuiAgent
  model?: string
  effort?: string
  stepIds: string[]
  parallelGroup?: string
}

export type SessionChainTeamSummary = {
  planning: SessionChainTeamPlanning | null
  seats: SessionChainTeamSeat[]
  counts: Record<SessionChainStepRole, number>
  parallelGroups: string[]
  maxRounds: number
}

function seatKey(step: SessionChainAgentStep): string {
  if (step.review) {
    return `review:${step.review.groupId}:${step.review.reviewerId}`
  }
  return step.reviewRepair ? `repair:${step.reviewRepair.groupId}` : `step:${step.id}`
}

/** The team a chain plans, for the hover card and the plan strip; null for a chain without roles. */
export function summarizeSessionChainTeam(
  chain: Pick<SessionChain, 'steps' | 'teamPlanning'>
): SessionChainTeamSummary | null {
  const seats = new Map<string, SessionChainTeamSeat>()
  let maxRounds = 0
  for (const step of chain.steps) {
    if (step.kind === 'handoff' || !step.role) {
      continue
    }
    maxRounds = Math.max(maxRounds, step.review?.maxRounds ?? 0)
    const key = seatKey(step)
    const seat = seats.get(key)
    if (seat) {
      seat.stepIds.push(step.id)
      continue
    }
    const parallelGroup = step.role === 'worker' && !step.review ? step.group : undefined
    seats.set(key, {
      key,
      role: step.role,
      agent: step.agent,
      ...(step.model ? { model: step.model } : {}),
      ...(step.effort ? { effort: step.effort } : {}),
      stepIds: [step.id],
      ...(parallelGroup ? { parallelGroup } : {})
    })
  }
  if (!seats.size) {
    return null
  }
  const counts = { producer: 0, worker: 0, reviewer: 0, repair: 0 }
  for (const seat of seats.values()) {
    counts[seat.role] += 1
  }
  return {
    planning: chain.teamPlanning ?? null,
    seats: [...seats.values()],
    counts,
    parallelGroups: [...new Set([...seats.values()].flatMap((seat) => seat.parallelGroup ?? []))],
    maxRounds
  }
}
