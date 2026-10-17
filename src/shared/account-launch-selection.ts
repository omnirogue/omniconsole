import { chooseHighestBalanceAccount } from './account-balance'
import type { ClaudeManagedAccount, CodexManagedAccount } from './managed-account-types'
import type { RateLimitRuntimeTarget, RateLimitState } from './rate-limit-types'

type AccountRuntime = { runtime: 'host' | 'wsl'; wslDistro?: string | null }
const SYSTEM_ACCOUNT = 'system-default'

function sameRuntime(a: AccountRuntime, b: AccountRuntime): boolean {
  return (
    a.runtime === b.runtime &&
    (a.runtime === 'host' || (a.wslDistro ?? null) === (b.wslDistro ?? null))
  )
}

export function chooseAccountForLaunch<T extends ClaudeManagedAccount | CodexManagedAccount>(args: {
  provider: 'claude' | 'codex'
  accounts: readonly T[]
  defaultAccountId: string | null
  target: RateLimitRuntimeTarget
  rateLimits: RateLimitState
  now?: number
}): (T & { launchEnv?: Record<string, string> }) | null {
  const { provider, defaultAccountId, target, rateLimits } = args
  const accounts = args.accounts.filter((account) =>
    sameRuntime(target, {
      runtime:
        ('managedAuthRuntime' in account
          ? account.managedAuthRuntime
          : (account as CodexManagedAccount).managedHomeRuntime) ?? 'host',
      wslDistro: account.wslDistro
    })
  )
  const rateTarget = rateLimits[provider === 'claude' ? 'claudeTarget' : 'codexTarget']
  const inactive =
    rateLimits[provider === 'claude' ? 'inactiveClaudeAccounts' : 'inactiveCodexAccounts']
  const capacity = target.runtime === 'host' ? rateLimits.accountCapacity?.[provider] : undefined
  if (capacity) {
    let available = capacity.filter(
      (row) => row.launchEnv && row.state !== 'signed-out' && row.state !== 'limited'
    )
    if (defaultAccountId !== null && available.some((row) => !row.isSystem)) {
      available = available.filter((row) => !row.isSystem)
    }
    const score = (row: (typeof available)[number]): number => {
      if (
        !row.readingAt ||
        (args.now ?? Date.now()) - row.readingAt > 300_000 ||
        (!row.fiveHour && !row.weekly)
      ) {
        return -1
      }
      return Math.min(row.fiveHour?.remainingPercent ?? 100, row.weekly?.remainingPercent ?? 100)
    }
    available.sort((a, b) => score(b) - score(a) || Number(b.isDefault) - Number(a.isDefault))
    const selected = available[0]
    if (!selected) {
      return null
    }
    const account = accounts.find((account) => account.id === selected.accountId)
    return account ? { ...account, launchEnv: selected.launchEnv! } : null
  }
  const candidates = accounts.map((account) => ({
    id: account.id,
    rateLimits:
      account.id === defaultAccountId && sameRuntime(target, rateTarget)
        ? rateLimits[provider]
        : inactive.find((entry) => entry.accountId === account.id)?.rateLimits
  }))
  if (defaultAccountId === null && sameRuntime(target, rateTarget)) {
    candidates.push({ id: SYSTEM_ACCOUNT, rateLimits: rateLimits[provider] })
  }
  const selected = chooseHighestBalanceAccount(
    candidates,
    defaultAccountId ?? SYSTEM_ACCOUNT,
    args.now
  )
  if (selected === SYSTEM_ACCOUNT) {
    return null
  }
  if (selected) {
    return accounts.find((account) => account.id === selected) ?? null
  }
  return accounts.find((account) => account.id === defaultAccountId) ?? null
}
