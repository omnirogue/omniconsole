import { capacityStateLine, capacityWindowLines } from '@/lib/account-capacity-format'
import type { AccountCapacityRow } from '../../../../../../shared/provider-account-capacity'

/**
 * The lines shown for one account row in the launcher menu. Built from the
 * same shared helpers Settings uses (see AccountCapacityWindows.tsx) so both
 * surfaces show identical state text and reading time for the same row.
 */
export function launcherAccountLines(row: AccountCapacityRow, now = Date.now()): string[] {
  const lines = capacityWindowLines(row, now)
  const state = capacityStateLine(row, now)
  return state === null ? lines : [...lines, state]
}
