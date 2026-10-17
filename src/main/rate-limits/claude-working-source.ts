import { translateMain as translate } from '../i18n/main-i18n'
import {
  refreshClaudeAccountSessionIfIdle,
  refreshClaudeManagedAccountIfIdle
} from '../claude-accounts/account-session-refresh'
import type { AccountSignedOutReason } from '../../shared/provider-account-capacity'
import { hasLiveClaudePtysForConfigDir } from '../claude-accounts/live-pty-gate'
import { join } from 'node:path'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import { readClaudeAccountSessionCredentials } from '../claude-accounts/account-session-credentials'
import {
  claudeCredentialHealth,
  orderClaudeWorkingSources,
  type ClaudeSourceCandidate
} from './claude-credential-health'
import {
  claudeSeatDirectories,
  readClaudeSeatCredentials,
  sameClaudeIdentity
} from './claude-seat-directory'
import {
  readClaudeManagedCredentialsJson,
  resolveClaudeManagedCredentialsLocation
} from './claude-managed-account-credentials'
import type { ExistingAccountDirectory } from './existing-account-directories'

export type ClaudeWorkingSource = ClaudeSourceCandidate & {
  read: () => Promise<string | null>
  refresh?: () => Promise<string | null>
}

export async function resolveClaudeWorkingSources(
  account: ClaudeManagedAccount,
  seats: readonly ExistingAccountDirectory[] = claudeSeatDirectories()
): Promise<ClaudeWorkingSource[]> {
  let probeFailed = false
  const candidates: ClaudeWorkingSource[] = []
  const rawBySource = new Map<ClaudeWorkingSource, string | null>()
  const inspect = async (source: ClaudeWorkingSource): Promise<void> => {
    let raw: string | null = null
    try {
      raw = await source.read()
    } catch {
      probeFailed = true
    }
    Object.assign(source, claudeCredentialHealth(raw))
    rawBySource.set(source, raw)
    candidates.push(source)
  }
  const location = resolveClaudeManagedCredentialsLocation(account)
  const matching = seats.filter((seat) => sameClaudeIdentity(account, seat))
  if (location) {
    const readSession = () =>
      readClaudeAccountSessionCredentials(
        account.id,
        location.managedAuthPath,
        account.lastAuthenticatedAt
      )
    await inspect({
      kind: 'session',
      path: join(location.managedAuthPath, 'session'),
      ...claudeCredentialHealth(null),
      read: readSession,
      ...(matching.length === 0
        ? {
            refresh: async () => {
              if (
                claudeSeatDirectories().some((seat) => sameClaudeIdentity(account, seat)) ||
                hasLiveClaudePtysForConfigDir(join(location.managedAuthPath, 'session'))
              ) {
                return null
              }
              return refreshClaudeAccountSessionIfIdle(
                account.id,
                location.managedAuthPath,
                account.lastAuthenticatedAt
              )
            }
          }
        : {})
    })
    const readManaged = () => readClaudeManagedCredentialsJson(location, { strict: true })
    await inspect({
      kind: 'managed',
      path: join(location.managedAuthPath, 'session'),
      ...claudeCredentialHealth(null),
      read: readManaged,
      ...(matching.length === 0
        ? {
            refresh: async () => {
              if (hasLiveClaudePtysForConfigDir(join(location.managedAuthPath, 'session'))) {
                return null
              }
              // Why: discovery can change between resolution and an attempted refresh.
              if (claudeSeatDirectories().some((seat) => sameClaudeIdentity(account, seat))) {
                return null
              }
              // Why: the CLI's rotated refresh token takes precedence over its managed mirror.
              if (claudeCredentialHealth(await readSession()).refreshUsable) {
                return refreshClaudeAccountSessionIfIdle(
                  account.id,
                  location.managedAuthPath,
                  account.lastAuthenticatedAt
                )
              }
              return refreshClaudeManagedAccountIfIdle(account)
            }
          }
        : {})
    })
  }
  for (const seat of matching) {
    const read = () => readClaudeSeatCredentials(seat.path)
    await inspect({
      kind: /[/\\]\.claude-accounts[/\\].+[/\\]slot-\d+$/.test(seat.path) ? 'pool' : 'seat',
      path: seat.path,
      ...claudeCredentialHealth(null),
      read
    })
  }
  const available: ClaudeWorkingSource[] = []
  let rejected = false
  for (const candidate of candidates) {
    if (!isRejectedClaudeSource(candidate, rawBySource.get(candidate) ?? null)) {
      available.push(candidate)
    } else {
      rejected = true
    }
  }
  unavailableReasons.set(
    account.id,
    rejected
      ? 'revoked'
      : candidates.some((candidate) => candidate.expired || candidate.refreshUsable)
        ? 'expired'
        : 'no-login'
  )
  // No same-identity seat and nothing launchable yet (a refresh-only session copy is
  // launchable: its CLI refreshes it on use): try the sole refresh-only managed mirror
  // once through its existing guarded refresh before ranking it out.
  if (
    matching.length === 0 &&
    !available.some(
      (candidate) =>
        candidate.accessUsable || (candidate.kind === 'session' && candidate.refreshUsable)
    )
  ) {
    const managedCandidate = available.find(
      (candidate) => candidate.kind === 'managed' && candidate.refreshUsable && candidate.refresh
    )
    if (managedCandidate) {
      let refreshedRaw: string | null = null
      try {
        refreshedRaw = (await managedCandidate.refresh?.()) ?? null
      } catch {
        refreshedRaw = null
      }
      if (refreshedRaw !== null) {
        Object.assign(managedCandidate, claudeCredentialHealth(refreshedRaw))
        rawBySource.set(managedCandidate, refreshedRaw)
      }
    }
  }
  // Empty, idle profiles must not hide a fresh sign-in saved by OmniConsole.
  const seatOwnsCredentials =
    probeFailed ||
    rejected ||
    // Unknown owners still block refresh; they cannot establish ownership of every empty profile.
    matching.some((seat) =>
      hasLiveClaudePtysForConfigDir(seat.path, { includeUnattributed: false })
    ) ||
    candidates.some(
      (source) =>
        (source.kind === 'seat' || source.kind === 'pool') &&
        (source.accessUsable || source.refreshUsable)
    )
  const ordered = orderClaudeWorkingSources(
    matching.length
      ? available.filter((source) =>
          seatOwnsCredentials
            ? source.kind === 'seat' || source.kind === 'pool'
            : source.kind === 'session' || source.kind === 'managed'
        )
      : available
  ) as ClaudeWorkingSource[]
  if (!ordered.length && probeFailed) {
    throw new Error(
      translate(
        'claudeAccount.credentialProbeUnavailable',
        'Claude credentials are temporarily unavailable. Try again.'
      )
    )
  }
  return ordered
}

const rejectedCredentials = new Map<string, string>()
export function rejectClaudeSource(source: ClaudeWorkingSource, raw: string): void {
  rejectedCredentials.set(JSON.stringify([source.kind, source.path]), raw)
}
export function isRejectedClaudeSource(source: ClaudeSourceCandidate, raw: string | null): boolean {
  return raw !== null && rejectedCredentials.get(JSON.stringify([source.kind, source.path])) === raw
}

const unavailableReasons = new Map<string, AccountSignedOutReason>()
export function claudeSourceUnavailableReason(accountId: string): AccountSignedOutReason {
  return unavailableReasons.get(accountId) ?? 'no-login'
}
