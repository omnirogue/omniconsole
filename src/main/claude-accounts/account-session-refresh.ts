import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import {
  claudeSeatDirectories,
  sameClaudeIdentity,
  hasClaudeSeatForManagedPath
} from '../rate-limits/claude-seat-directory'
import {
  resolveClaudeManagedCredentialsLocation,
  readClaudeManagedCredentialsJson,
  writeClaudeManagedCredentialsJson
} from '../rate-limits/claude-managed-account-credentials'
import { join } from 'node:path'
import {
  readClaudeAccountSessionCredentials,
  writeClaudeAccountSessionCredentials
} from './account-session-credentials'
import { resolveOwnedClaudeManagedAuthPath, writeClaudeManagedAuthFile } from './managed-auth-path'
import { writeManagedClaudeKeychainCredentials } from './keychain'
import { isOauthTokenExpiring, refreshClaudeOauthCredentials } from './oauth-refresh'
import {
  beginClaudeAuthSwitch,
  endClaudeAuthSwitch,
  hasLiveClaudePtysForConfigDir,
  isClaudeAuthSwitchInProgress
} from './live-pty-gate'

const pending = new Map<string, Promise<string | null>>()
let manualMutations = 0

/** Complete existing refresh writes before a sign-in, selection or removal captures its snapshot. */
export async function withClaudeAccountMutation<T>(operation: () => Promise<T>): Promise<T> {
  manualMutations += 1
  try {
    await Promise.allSettled(pending.values())
    return await operation()
  } finally {
    manualMutations -= 1
  }
}

/** Parked sessions refresh in one place; live CLIs keep ownership of their tokens. */
export function refreshClaudeAccountSessionIfIdle(
  accountId: string,
  authPath: string,
  revision?: number
): Promise<string | null> {
  const key = `${authPath}:${accountId}:${revision}`
  const existing = pending.get(key)
  if (existing) {
    return existing
  }
  const operation = refreshIdleSession(accountId, authPath, revision).finally(() =>
    pending.delete(key)
  )
  pending.set(key, operation)
  return operation
}

async function refreshIdleSession(
  accountId: string,
  authPath: string,
  revision?: number
): Promise<string | null> {
  const owned = resolveOwnedClaudeManagedAuthPath(accountId, authPath, { adoptLegacyMarker: true })
  if (!owned) {
    return null
  }
  const credentials = await readClaudeAccountSessionCredentials(accountId, owned, revision)
  if (
    hasClaudeSeatForManagedPath(owned) ||
    manualMutations > 0 ||
    !credentials ||
    !isOauthTokenExpiring(credentials) ||
    hasLiveClaudePtysForConfigDir(join(owned, 'session')) ||
    isClaudeAuthSwitchInProgress()
  ) {
    return credentials
  }
  beginClaudeAuthSwitch()
  try {
    const refreshed = await refreshClaudeOauthCredentials(credentials)
    if (!refreshed) {
      return credentials
    }
    // Persist the CLI-owned copy first so a failed mirror cannot strand its rotated token.
    await writeClaudeAccountSessionCredentials(accountId, owned, refreshed, revision)
    if (process.platform === 'darwin') {
      await writeManagedClaudeKeychainCredentials(accountId, refreshed)
    } else {
      writeClaudeManagedAuthFile(owned, '.credentials.json', refreshed)
    }
    return refreshed
  } finally {
    endClaudeAuthSwitch()
  }
}

/** Managed mirrors share the session refresh and manual mutation exclusion gate. */
export function refreshClaudeManagedAccountIfIdle(
  account: ClaudeManagedAccount,
  options: { ownerHoldsMutation?: boolean } = {}
): Promise<string | null> {
  const key = `${account.managedAuthPath}:${account.id}:${account.lastAuthenticatedAt}`
  const existing = pending.get(key)
  if (existing) {
    return existing
  }
  const operation = refreshIdleManaged(account, options.ownerHoldsMutation ?? false).finally(() =>
    pending.delete(key)
  )
  pending.set(key, operation)
  return operation
}

async function refreshIdleManaged(
  account: ClaudeManagedAccount,
  ownerHoldsMutation: boolean
): Promise<string | null> {
  const location = resolveClaudeManagedCredentialsLocation(account)
  const blocked = () =>
    !ownerHoldsMutation && (manualMutations > 0 || isClaudeAuthSwitchInProgress())
  if (!location || blocked()) {
    return null
  }
  const credentials = await readClaudeManagedCredentialsJson(location)
  if (
    !credentials ||
    !isOauthTokenExpiring(credentials) ||
    blocked() ||
    hasLiveClaudePtysForConfigDir(join(location.managedAuthPath, 'session')) ||
    claudeSeatDirectories().some((seat) => sameClaudeIdentity(account, seat))
  ) {
    return null
  }
  const ownsSwitch = !isClaudeAuthSwitchInProgress()
  if (ownsSwitch) {
    beginClaudeAuthSwitch()
  }
  try {
    const refreshed = await refreshClaudeOauthCredentials(credentials)
    if (
      !refreshed ||
      (await readClaudeManagedCredentialsJson(location)) !== credentials ||
      claudeSeatDirectories().some((seat) => sameClaudeIdentity(account, seat))
    ) {
      return null
    }
    await writeClaudeManagedCredentialsJson(location, refreshed)
    return refreshed
  } finally {
    if (ownsSwitch) {
      endClaudeAuthSwitch()
    }
  }
}
