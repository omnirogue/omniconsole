export const DEFAULT_CARDLESS_HANDOFFS = true

/** Session handoffs are independent of tasks; retain the legacy argument for saved profiles. */
export function cardlessHandoffsEnabledByPreference(
  _settings: { experimentalCardlessHandoffs?: boolean } | null | undefined
): boolean {
  return DEFAULT_CARDLESS_HANDOFFS
}
