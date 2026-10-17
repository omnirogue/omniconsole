import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type {
  AccountCapacityRow,
  CapacityProvider
} from '../../../shared/provider-account-capacity'

const EMPTY: AccountCapacityRow[] = []

/**
 * The local host's per-account capacity rows for one provider — the same rows
 * Settings › AI Provider Accounts renders, refreshed by every `rateLimits:update`.
 */
export function useAccountCapacityRows(provider: CapacityProvider): AccountCapacityRow[] {
  return useAppStore(useShallow((state) => state.rateLimits.accountCapacity?.[provider] ?? EMPTY))
}
