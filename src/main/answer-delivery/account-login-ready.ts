/**
 * Is an account's login working on this computer again? Read from the account capacity rows only
 * (never the credential): a fresh usage reading the provider answered after the failure proves
 * the login, a signed-out row disproves it, and anything else is checked again, never assumed.
 */

import { basename, join, resolve } from 'node:path'
import { classifyLaunchAccountRow } from '../../shared/account-launch-verdict'
import type { ClaudeManagedAccount, CodexManagedAccount } from '../../shared/managed-account-types'
import type { AccountCapacityRow, CapacityProvider } from '../../shared/provider-account-capacity'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'

/** A reading the provider answered within this long proves the login (the capacity row's own `ready` bound). */
const LOGIN_READING_FRESH_MS = 5 * 60_000
const REFRESH_EVERY_MS = 60_000

/** A managed account id or capacity choice id, or the provider home a conversation runs under. */
export type AccountLoginTarget =
  | string
  | {
      provider: CapacityProvider
      accountId?: string | null
      /** `CLAUDE_CONFIG_DIR` / `CODEX_HOME` the conversation used. */
      home?: string | null
      /** Only a reading after this (the failure) proves the login came back. */
      since?: number
    }

export type AccountLoginReadiness =
  | { ready: true; label: string }
  | { ready: false; reason: string; held: 'login_failed' | 'account_at_limit'; retryAfter?: number }

type ManagedAccounts = {
  claudeManagedAccounts?: Pick<ClaudeManagedAccount, 'id' | 'managedAuthPath'>[]
  codexManagedAccounts?: Pick<CodexManagedAccount, 'id' | 'managedHomePath'>[]
}

const homeOf = (row: AccountCapacityRow): string | undefined =>
  row.launchEnv?.[row.provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']

const samePath = (a: string, b: string): boolean => resolve(a) === resolve(b)

/** The managed account whose home this is; a signed-out row no longer names its home. */
function managedAccountIdFor(
  provider: CapacityProvider,
  home: string,
  managed: ManagedAccounts
): string | undefined {
  if (provider === 'claude') {
    return managed.claudeManagedAccounts?.find(
      (account) =>
        samePath(home, account.managedAuthPath) ||
        samePath(home, join(account.managedAuthPath, 'session'))
    )?.id
  }
  return managed.codexManagedAccounts?.find((account) => samePath(home, account.managedHomePath))
    ?.id
}

export function findLoginRow(
  rows: { claude: AccountCapacityRow[]; codex: AccountCapacityRow[] },
  managed: ManagedAccounts,
  target: AccountLoginTarget
): AccountCapacityRow | undefined {
  if (typeof target === 'string') {
    return [...rows.claude, ...rows.codex].find(
      (row) => row.accountId === target || row.choiceId === target
    )
  }
  const candidates = rows[target.provider]
  if (target.accountId) {
    return candidates.find((row) => row.accountId === target.accountId)
  }
  const home = target.home
  if (!home) {
    return undefined
  }
  const byHome = candidates.find((row) => {
    const rowHome = homeOf(row)
    return rowHome !== undefined && samePath(rowHome, home)
  })
  if (byHome) {
    return byHome
  }
  const accountId = managedAccountIdFor(target.provider, home, managed)
  if (accountId) {
    return candidates.find((row) => row.accountId === accountId)
  }
  // Why the System row: the provider's default home is the System login.
  return basename(home) === (target.provider === 'claude' ? '.claude' : '.codex')
    ? candidates.find((row) => row.isSystem)
    : undefined
}

/** The verdict from the rows alone; `refresh` is true when a newer reading would decide it. */
export function loginReadinessOf(
  row: AccountCapacityRow | undefined,
  options: { now: number; since?: number }
): AccountLoginReadiness & { refresh?: true } {
  if (!row) {
    return {
      ready: false,
      held: 'login_failed',
      reason: 'no login on this computer names this account'
    }
  }
  const label = row.isSystem ? 'the System login' : (row.email ?? 'its account')
  const verdict = classifyLaunchAccountRow(row, {
    now: options.now,
    freshMs: LOGIN_READING_FRESH_MS,
    fable: 'ignore'
  })
  if (verdict.state === 'signed-out') {
    return {
      ready: false,
      held: 'login_failed',
      reason: `${label} is signed out on this computer (${verdict.reason})`
    }
  }
  if (verdict.state === 'limited') {
    return {
      ready: false,
      held: 'account_at_limit',
      reason: `${label} works again but is at its usage limit (${verdict.reason})`,
      ...(verdict.until ? { retryAfter: verdict.until } : {})
    }
  }
  if (
    verdict.state === 'fresh' &&
    (options.since === undefined || (row.readingAt ?? 0) > options.since)
  ) {
    return { ready: true, label }
  }
  return {
    ready: false,
    held: 'login_failed',
    reason: `checking ${label}'s login (${verdict.state === 'fresh' ? 'no reading since the failure' : verdict.reason})`,
    refresh: true
  }
}

type LoginRuntime = Pick<
  OrcaRuntimeService,
  'getAccountsSnapshot' | 'refreshAccountsForMobileSubscriber' | 'getAgentAccountSettings'
>

let lastRefreshAt = 0

/** Is `target`'s login working here now? Asks for a newer reading (at most once a minute) when unsure. */
export async function accountLoginReady(
  runtime: LoginRuntime,
  target: AccountLoginTarget,
  now = Date.now()
): Promise<AccountLoginReadiness> {
  let snapshot: ReturnType<LoginRuntime['getAccountsSnapshot']>
  try {
    snapshot = runtime.getAccountsSnapshot()
  } catch {
    return { ready: false, held: 'login_failed', reason: 'account services are not running yet' }
  }
  const capacity = snapshot.rateLimits.accountCapacity
  const row = findLoginRow(
    { claude: capacity?.claude ?? [], codex: capacity?.codex ?? [] },
    runtime.getAgentAccountSettings(),
    target
  )
  const { refresh, ...readiness } = loginReadinessOf(row, {
    now,
    ...(typeof target === 'object' && target.since !== undefined ? { since: target.since } : {})
  })
  if (refresh && now - lastRefreshAt >= REFRESH_EVERY_MS) {
    lastRefreshAt = now
    void runtime.refreshAccountsForMobileSubscriber().catch(() => {})
  }
  return readiness
}
