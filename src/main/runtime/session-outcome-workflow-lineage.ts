import type { SessionChain } from '../../shared/session-chain-types'

/** List position is not authority to consume another outcome's accepted work. */
export function sessionOutcomeLineage(chain: SessionChain, owners: Iterable<string>): Set<string> {
  const outcomes = chain.outcomeSet!.outcomes
  const ids = new Set(owners)
  for (const id of ids) {
    const outcome = outcomes.find((entry) => entry.id === id)
    if (!outcome) {
      throw new Error('The outcome source dependency is no longer part of this saved plan.')
    }
    outcome.dependsOn.forEach((dependency) => ids.add(dependency))
  }
  return ids
}
