export type DispatchRoutingMode = 'off' | 'shadow' | 'live'

/** Host rollback or observation overrides an intake; a live host can accept a narrower request. */
export function resolveDispatchRoutingMode(
  hostMode: DispatchRoutingMode | undefined,
  requested?: DispatchRoutingMode
): DispatchRoutingMode {
  return hostMode === 'off' || hostMode === 'shadow' ? hostMode : (requested ?? 'live')
}
