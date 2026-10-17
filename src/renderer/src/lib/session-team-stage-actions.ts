import type { SessionChain } from '../../../shared/session-chain-types'

/**
 * Stage keys whose work is durably finished by outcome actions rather than chain steps.
 * Why: an action stage carries no `stepIds`, so without its attempts it would stay unbound and
 * inherit the chain's aggregate ending — reading `skipped` on a done plan, `failed` on a stopped one.
 */
export function completedActionStageKeys(chain: SessionChain | null): ReadonlySet<string> {
  const completedActions = new Set(
    (chain?.outcomeSet?.attempts ?? [])
      .filter((attempt) => attempt.state === 'completed')
      .map((attempt) => attempt.actionId)
  )
  const keys = new Set<string>()
  for (const stage of chain?.outcomeSet?.workflow?.stages ?? []) {
    if (
      stage.actionIds.length > 0 &&
      stage.actionIds.every((actionId) => completedActions.has(actionId))
    ) {
      keys.add(stage.key)
    }
  }
  return keys
}
