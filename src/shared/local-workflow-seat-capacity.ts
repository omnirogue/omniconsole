import type { AccountCapacityRow } from './provider-account-capacity'
import { MANAGED_ACCOUNT_CHOICE_PREFIX } from './agent-account-profiles'
import type { LocalWorkflowRoute } from './local-workflow-seats'
import { classifyLaunchAccountRow } from './account-launch-verdict'

/** A reading older than this is stale: the same bound the account rows use for `ready`. */
export const WORKFLOW_CAPACITY_FRESH_MS = 300_000

/**
 * A workflow account's usage as the host last verified it. Only `fresh` is spare capacity:
 * `stale` (an old or paused reading), `unknown` (no reading, or a route without readings),
 * `limited` (a window is exhausted) and `signed-out` never are.
 */
export type LocalWorkflowSeatCapacity =
  | { state: 'fresh'; remainingPercent: number }
  | { state: 'stale' | 'unknown' | 'limited' | 'signed-out' }

/** The capacity row a workflow account id names: `system:<route>` or `managed:<id>`. */
function rowFor(
  rows: readonly AccountCapacityRow[],
  accountId: string
): AccountCapacityRow | undefined {
  if (accountId.startsWith('system:')) {
    return rows.find((row) => row.isSystem)
  }
  if (accountId.startsWith(MANAGED_ACCOUNT_CHOICE_PREFIX)) {
    const id = accountId.slice(MANAGED_ACCOUNT_CHOICE_PREFIX.length)
    return rows.find((row) => row.accountId === id)
  }
  return undefined
}

/** One account's capacity from the host's account rows; routes without readings are unknown. */
export function workflowSeatCapacity(
  capacity:
    | { claude: readonly AccountCapacityRow[]; codex: readonly AccountCapacityRow[] }
    | null
    | undefined,
  agent: LocalWorkflowRoute,
  accountId: string,
  now = Date.now()
): LocalWorkflowSeatCapacity {
  if (!capacity || (agent !== 'claude' && agent !== 'codex')) {
    return { state: 'unknown' }
  }
  const row = rowFor(capacity[agent], accountId)
  if (!row) {
    return { state: 'unknown' }
  }
  const verdict = classifyLaunchAccountRow(row, {
    now,
    freshMs: WORKFLOW_CAPACITY_FRESH_MS,
    fable: 'ignore'
  })
  return verdict.state === 'fresh'
    ? { state: 'fresh', remainingPercent: verdict.remainingPercent }
    : { state: verdict.state }
}

/**
 * The account a route defaults to: the one with the most fresh, verified capacity (the tighter
 * of its session and weekly windows), ties broken by account id. With no fresh account, the first
 * one in catalog order not known to be limited or signed out, else the first; `verified` is then
 * false so the caller can say so. The system login is one candidate like any other.
 */
export function chooseWorkflowRouteAccount<
  T extends { accountId: string; capacity?: LocalWorkflowSeatCapacity }
>(candidates: readonly T[]): { entry: T; verified: boolean } | undefined {
  const fresh = candidates
    .flatMap((entry) =>
      entry.capacity?.state === 'fresh'
        ? [{ entry, remaining: entry.capacity.remainingPercent }]
        : []
    )
    .sort((a, b) => b.remaining - a.remaining || a.entry.accountId.localeCompare(b.entry.accountId))
  if (fresh[0]) {
    return { entry: fresh[0].entry, verified: true }
  }
  const open = candidates.find(
    (entry) => entry.capacity?.state !== 'limited' && entry.capacity?.state !== 'signed-out'
  )
  const entry = open ?? candidates[0]
  return entry ? { entry, verified: false } : undefined
}

/** Why an account a run starts on is not verified spare capacity; undefined when it is. */
export function workflowSeatCapacityNote(
  providerLabel: string,
  accountLabel: string,
  capacity: LocalWorkflowSeatCapacity | undefined
): string | undefined {
  const state = capacity?.state ?? 'unknown'
  if (state === 'fresh') {
    return undefined
  }
  const why =
    state === 'limited'
      ? 'was at its usage limit'
      : state === 'signed-out'
        ? 'had no working sign-in'
        : state === 'stale'
          ? 'had no current usage reading'
          : 'had no usage reading'
  return `${providerLabel} ran on ${accountLabel}, which ${why} when the run started; its remaining capacity was not verified.`
}
