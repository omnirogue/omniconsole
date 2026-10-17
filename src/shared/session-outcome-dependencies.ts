import type { SessionOutcomeSet } from './session-outcome-types'

export type SessionOutcomeBlocker = {
  outcomeId: string
  title: string
  /**
   * `failed`: the host blocked it. `abandoned`: it was removed from the plan. `missing`: the
   * plan names it but carries no such outcome, so the runner can never start the dependent.
   */
  cause: 'failed' | 'abandoned' | 'missing'
  detail: string | null
}

export type SessionOutcomeDependencyView =
  | { outcomeId: string; title: string; state: 'free' | 'ready' }
  | { outcomeId: string; title: string; state: 'waiting'; waitingOn: string[] }
  | { outcomeId: string; title: string; state: 'blocked'; blockedBy: SessionOutcomeBlocker[] }

/**
 * Per outcome, what its `dependsOn` means right now: nothing to wait for (`free`), every
 * prerequisite satisfied (`ready`), still waiting on named outcomes, or unable to run because
 * a prerequisite — directly or further up the chain — failed or was abandoned.
 */
export function sessionOutcomeDependencies(
  set: Pick<SessionOutcomeSet, 'outcomes' | 'removals'> | null | undefined
): SessionOutcomeDependencyView[] {
  if (!set) {
    return []
  }
  const byId = new Map(set.outcomes.map((outcome) => [outcome.id, outcome]))
  // Why optional: chains cached before removals existed, and partial projections, omit it.
  const removed = new Set((set.removals ?? []).map((removal) => removal.outcomeId))
  const dependsOn = (outcome: { dependsOn?: string[] }) => outcome.dependsOn ?? []
  const memo = new Map<string, SessionOutcomeBlocker[]>()

  // Root causes that keep `id` from ever running; a cycle guard stops a malformed plan looping.
  const rootBlockers = (id: string, trail: Set<string>): SessionOutcomeBlocker[] => {
    const cached = memo.get(id)
    if (cached) {
      return cached
    }
    const outcome = byId.get(id)
    if (!outcome || trail.has(id)) {
      return []
    }
    trail.add(id)
    const found: SessionOutcomeBlocker[] = []
    for (const dep of dependsOn(outcome)) {
      const prerequisite = byId.get(dep)
      if (!prerequisite) {
        // Why not ready: session-outcome-tick only runs an outcome whose every dependsOn is satisfied.
        found.push({
          outcomeId: dep,
          title: dep,
          cause: removed.has(dep) ? 'abandoned' : 'missing',
          detail: null
        })
        continue
      }
      if (prerequisite.status === 'blocked') {
        found.push({
          outcomeId: dep,
          title: prerequisite.title,
          cause: 'failed',
          detail: prerequisite.blockedReason ?? null
        })
      } else if (prerequisite.status !== 'satisfied') {
        found.push(...rootBlockers(dep, trail))
      }
    }
    trail.delete(id)
    const unique = [...new Map(found.map((entry) => [entry.outcomeId, entry])).values()]
    memo.set(id, unique)
    return unique
  }

  return set.outcomes.map((outcome) => {
    const base = { outcomeId: outcome.id, title: outcome.title }
    if (dependsOn(outcome).length === 0) {
      return { ...base, state: 'free' as const }
    }
    const blockedBy = rootBlockers(outcome.id, new Set())
    if (blockedBy.length > 0) {
      return { ...base, state: 'blocked' as const, blockedBy }
    }
    const waitingOn = dependsOn(outcome)
      .map((id) => byId.get(id))
      .filter((dep) => dep !== undefined && dep.status !== 'satisfied')
      .map((dep) => dep!.title)
    return waitingOn.length > 0
      ? { ...base, state: 'waiting' as const, waitingOn }
      : { ...base, state: 'ready' as const }
  })
}
