/**
 * Whether an automatic cleanup run may start now: the provider and account that run will use must
 * have a fresh reading with room left. Unknown, stale, limited, signed-out or still-checking usage
 * is no capacity (the plan: doubt never spends someone's quota unattended).
 */

import type { AutomationLaunchPreferences } from '../../shared/automation-launch-preferences'
import type {
  AccountCapacityRow,
  CapacityProvider,
  ProviderAccountCapacitySnapshot
} from '../../shared/provider-account-capacity'
import type { TuiAgent } from '../../shared/tui-agent'

/** The same freshness the launcher trusts a reading for (`account-launch-selection.ts`). */
export const CLEANUP_CAPACITY_FRESH_MS = 300_000
/** Room a short cleanup must leave in every reported window. */
export const CLEANUP_MIN_REMAINING_PERCENT = 20

export type CleanupCapacityVerdict = { ok: true } | { ok: false; detail: string; why: string }

function providerOf(agent: TuiAgent): CapacityProvider | null {
  return agent === 'claude' || agent === 'codex' ? agent : null
}

/** The row the run launches with: a pinned Codex account, else the default login. */
function launchRow(
  rows: readonly AccountCapacityRow[],
  provider: CapacityProvider,
  preferences: AutomationLaunchPreferences | undefined
): AccountCapacityRow | undefined {
  const pinned = provider === 'codex' ? preferences?.codexAccountId : undefined
  if (pinned) {
    return rows.find((row) => row.accountId === pinned)
  }
  return rows.find((row) => row.isDefault) ?? rows.find((row) => row.isSystem)
}

function stateWhy(row: AccountCapacityRow): string | null {
  switch (row.state) {
    case 'ready':
      return null
    case 'limited':
      return row.limitedUntil
        ? `the account is limited until ${new Date(row.limitedUntil).toLocaleTimeString()}`
        : 'the account is limited'
    case 'signed-out':
      return 'the account is signed out on this computer'
    case 'checking':
      return 'its usage is still being read'
    case 'usable':
      return 'there is no current usage reading'
  }
}

export function cleanupCapacity(input: {
  agent: TuiAgent
  launchPreferences?: AutomationLaunchPreferences
  snapshot: ProviderAccountCapacitySnapshot | null | undefined
  now: number
}): CleanupCapacityVerdict {
  const provider = providerOf(input.agent)
  const detail = `capacity (${input.agent})`
  if (!provider) {
    return { ok: false, detail, why: 'OmniConsole cannot read this agent’s usage' }
  }
  const row = input.snapshot
    ? launchRow(input.snapshot[provider], provider, input.launchPreferences)
    : undefined
  if (!row) {
    return { ok: false, detail, why: 'no usage reading for the account this run would use' }
  }
  const state = stateWhy(row)
  if (state) {
    return { ok: false, detail, why: state }
  }
  if (row.readingAt === null || input.now - row.readingAt > CLEANUP_CAPACITY_FRESH_MS) {
    return { ok: false, detail, why: 'its usage reading is out of date' }
  }
  const windows = [row.fiveHour, row.weekly].filter((window) => window !== null)
  if (windows.length === 0) {
    return { ok: false, detail, why: 'no usage window was reported' }
  }
  const least = Math.min(...windows.map((window) => window.remainingPercent))
  if (least < CLEANUP_MIN_REMAINING_PERCENT) {
    return { ok: false, detail, why: `only ${Math.round(least)}% of its usage is left` }
  }
  return { ok: true }
}
