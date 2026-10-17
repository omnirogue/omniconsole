import { readClaudeManagedAuthFile } from '../claude-accounts/managed-auth-path'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import {
  discoverExistingAccountDirectories,
  type ExistingAccountDirectory
} from './existing-account-directories'
import { readActiveClaudeKeychainCredentialsStrict } from '../claude-accounts/keychain'

export function systemClaudeConfigDir(): string {
  return resolve(process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude'))
}

export function claudeSeatDirectories(): ExistingAccountDirectory[] {
  const profiles = discoverExistingAccountDirectories(homedir()).filter(
    (profile) => profile.provider === 'claude' && profile.runtime !== 'wsl'
  )
  const path = systemClaudeConfigDir()
  if (!profiles.some((profile) => profile.path === path)) {
    try {
      const account = JSON.parse(readFileSync(join(path, '.claude.json'), 'utf8')).oauthAccount
      profiles.push({
        provider: 'claude',
        path,
        email: account?.emailAddress,
        organizationUuid: account?.organizationUuid
      })
    } catch {
      /* No identity is established for this directory. */
    }
  }
  return profiles
}

export function sameClaudeIdentity(
  a: { email?: string | null; organizationUuid?: string | null },
  b: { email?: string | null; organizationUuid?: string | null }
): boolean {
  return (
    Boolean(a.email && b.email) &&
    a.email?.trim().toLowerCase() === b.email?.trim().toLowerCase() &&
    (a.organizationUuid ?? null) === (b.organizationUuid ?? null)
  )
}

export async function readClaudeSeatCredentials(path: string): Promise<string | null> {
  if (process.platform === 'darwin') {
    const scoped = await readActiveClaudeKeychainCredentialsStrict(path)
    if (scoped) {
      return scoped
    }
    if (path === join(homedir(), '.claude')) {
      const legacy = await readActiveClaudeKeychainCredentialsStrict()
      if (legacy) {
        return legacy
      }
    }
  }
  try {
    return readFileSync(join(path, '.credentials.json'), 'utf8')
  } catch {
    return null
  }
}

export function persistClaudeSeatDirectories(
  path: string,
  profiles: readonly ExistingAccountDirectory[]
): boolean {
  const seats = profiles
    .filter((profile) => profile.provider === 'claude')
    .map(({ path, email, organizationUuid, runtime, wslDistro }) => ({
      path,
      email,
      organizationUuid,
      runtime,
      wslDistro
    }))
  const serialized = JSON.stringify({ version: 1, seats })
  try {
    if (readFileSync(path, 'utf8') === serialized) {
      return false
    }
  } catch {
    /* First scan. */
  }
  writeFileSync(`${path}.tmp`, serialized, { mode: 0o600 })
  renameSync(`${path}.tmp`, path)
  return true
}

export function hasClaudeSeatForManagedPath(authPath: string): boolean {
  try {
    const identity = JSON.parse(readClaudeManagedAuthFile(authPath, 'oauth-account.json') ?? '{}')
    if (typeof identity.emailAddress !== 'string') {
      return true
    }
    return claudeSeatDirectories().some((seat) =>
      sameClaudeIdentity(
        { email: identity.emailAddress, organizationUuid: identity.organizationUuid },
        seat
      )
    )
  } catch {
    return true
  }
}
