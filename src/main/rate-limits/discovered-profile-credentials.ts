import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readActiveClaudeKeychainCredentialsStrict } from '../claude-accounts/keychain'
import type { ExistingAccountDirectory } from './existing-account-directories'

export async function hasDiscoveredProfileCredentials(
  profile: ExistingAccountDirectory
): Promise<boolean> {
  let raw: string | null = null
  if (profile.provider === 'claude' && process.platform === 'darwin') {
    raw = await readActiveClaudeKeychainCredentialsStrict(profile.path)
    if (!raw && profile.path === join(homedir(), '.claude')) {
      raw = await readActiveClaudeKeychainCredentialsStrict()
    }
  }
  if (!raw) {
    try {
      raw = readFileSync(
        join(profile.path, profile.provider === 'claude' ? '.credentials.json' : 'auth.json'),
        'utf8'
      )
    } catch {
      return false
    }
  }
  try {
    const auth = JSON.parse(raw)
    if (profile.provider === 'claude') {
      return Boolean(auth.claudeAiOauth?.accessToken || auth.claudeAiOauth?.refreshToken)
    }
    return Boolean(auth.tokens?.access_token || auth.tokens?.refresh_token)
  } catch {
    return false
  }
}
