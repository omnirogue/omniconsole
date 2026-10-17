import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import {
  readActiveClaudeKeychainCredentialsStrict,
  writeActiveClaudeKeychainCredentials
} from './keychain'
import { resolveOwnedClaudeManagedAuthPath } from './managed-auth-path'

export function sessionDirectory(authPath: string): string {
  return join(authPath, 'session')
}

function matchesSessionRevision(path: string, accountId: string, revision?: number): boolean {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      return false
    }
    const marker = join(path, '.omni-account-session.json')
    if (lstatSync(marker).isSymbolicLink()) {
      return false
    }
    const data = JSON.parse(readFileSync(marker, 'utf8'))
    return (
      data.accountId === accountId && (revision === undefined || data.authenticatedAt === revision)
    )
  } catch {
    return false
  }
}

/** A running CLI owns refreshes in its isolated directory, separate from usage-panel staging. */
export async function readClaudeAccountSessionCredentials(
  accountId: string,
  authPath: string,
  revision?: number
): Promise<string | null> {
  const path = sessionDirectory(authPath)
  if (!matchesSessionRevision(path, accountId, revision)) {
    return null
  }
  if (process.platform === 'darwin') {
    return readActiveClaudeKeychainCredentialsStrict(path)
  }
  try {
    const credentialsPath = join(path, '.credentials.json')
    if (lstatSync(credentialsPath).isSymbolicLink()) {
      return null
    }
    return readFileSync(credentialsPath, 'utf8')
  } catch {
    return null
  }
}

export async function writeClaudeAccountSessionCredentials(
  accountId: string,
  authPath: string,
  credentials: string,
  revision?: number
): Promise<void> {
  const owned = resolveOwnedClaudeManagedAuthPath(accountId, authPath, { adoptLegacyMarker: true })
  const path = sessionDirectory(authPath)
  if (!owned || !matchesSessionRevision(path, accountId, revision)) {
    throw new Error('The Claude sign-in changed during refresh.')
  }
  if (process.platform === 'darwin') {
    await writeActiveClaudeKeychainCredentials(credentials, path)
  } else {
    writeFileAtomically(join(path, '.credentials.json'), credentials, { mode: 0o600 })
  }
}
