import { copyClaudeResumeTranscript } from './account-session-transcript'
import { translateMain as translate } from '../i18n/main-i18n'
import { claudeSeatDirectories, sameClaudeIdentity } from '../rate-limits/claude-seat-directory'
import {
  readClaudeAccountSessionCredentials,
  sessionDirectory
} from './account-session-credentials'
export {
  readClaudeAccountSessionCredentials,
  writeClaudeAccountSessionCredentials
} from './account-session-credentials'
import {
  resolveClaudeWorkingSources,
  isRejectedClaudeSource
} from '../rate-limits/claude-working-source'
import { claudeCredentialHealth } from '../rate-limits/claude-credential-health'
import { existsSync, lstatSync, mkdirSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { writeActiveClaudeKeychainCredentials } from './keychain'
import { readClaudeManagedAuthFile, resolveOwnedClaudeManagedAuthPath } from './managed-auth-path'
import type { ClaudeRuntimeAuthPreparation } from './runtime-auth-service'
import { ensureClaudeHooksForRequestedEnv } from './account-directory-hooks'
import { syncHomeClaudeConfigIntoAccountDirectory } from './account-directory-home-config'
import { shareDefaultSessionRegistry } from './account-session-registry'

const pendingPreparations = new Map<string, Promise<ClaudeRuntimeAuthPreparation>>()

export function prepareClaudeAccountSession(
  account: ClaudeManagedAccount,
  options: { preserveSessionDirectory?: boolean; transcriptPath?: string } = {}
): Promise<ClaudeRuntimeAuthPreparation> {
  const key = `${account.managedAuthPath}:${account.id}:${account.lastAuthenticatedAt}:${options.preserveSessionDirectory ?? false}:${options.transcriptPath ?? ''}`
  const pending = pendingPreparations.get(key)
  if (pending) {
    return pending
  }
  const operation = prepareSession(account, options).finally(() => pendingPreparations.delete(key))
  pendingPreparations.set(key, operation)
  return operation
}

async function prepareSession(
  account: ClaudeManagedAccount,
  options: { preserveSessionDirectory?: boolean; transcriptPath?: string }
): Promise<ClaudeRuntimeAuthPreparation> {
  if (account.managedAuthRuntime === 'wsl') {
    throw new Error('WSL accounts must use WSL runtime preparation.')
  }
  const authPath = resolveOwnedClaudeManagedAuthPath(account.id, account.managedAuthPath, {
    adoptLegacyMarker: true
  })
  if (!authPath) {
    throw new Error('The Claude account sign-in directory is unavailable.')
  }
  const path = sessionDirectory(authPath)
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error('The Claude account session directory is not owned by OmniConsole.')
  }
  const source = (await resolveClaudeWorkingSources(account))[0]
  if (!source) {
    throw new Error(
      translate(
        'claudeAccount.signInBeforeLaunch',
        'Sign in to this Claude account again before launching.'
      )
    )
  }
  const prepareSeat = async (): Promise<ClaudeRuntimeAuthPreparation | null> => {
    const matching = claudeSeatDirectories().filter((candidate) =>
      sameClaudeIdentity(account, candidate)
    )
    if (!matching.length) {
      return null
    }
    const latestSource = (await resolveClaudeWorkingSources(account, matching))[0]
    if (!latestSource) {
      throw new Error(
        translate(
          'claudeAccount.signInBeforeLaunch',
          'Sign in to this Claude account again before launching.'
        )
      )
    }
    const seat = matching.find((candidate) => candidate.path === latestSource.path)
    if (!seat) {
      return null
    }
    if (options.preserveSessionDirectory && options.transcriptPath) {
      copyClaudeResumeTranscript(path, seat.path, options.transcriptPath)
    }
    ensureClaudeHooksForRequestedEnv({ CLAUDE_CONFIG_DIR: seat.path })
    return {
      configDir: seat.path,
      envPatch: { CLAUDE_CONFIG_DIR: seat.path },
      stripAuthEnv: true,
      provenance: `profile:${seat.path}`
    }
  }
  const seat = await prepareSeat()
  if (seat) {
    return seat
  }
  let credentials = await readClaudeAccountSessionCredentials(
    account.id,
    authPath,
    account.lastAuthenticatedAt
  )
  if (
    !credentials ||
    !claudeCredentialHealth(credentials).refreshUsable ||
    isRejectedClaudeSource(
      { ...claudeCredentialHealth(credentials), kind: 'session', path },
      credentials
    )
  ) {
    credentials = source.kind === 'managed' ? await source.read() : null
    if (
      !credentials ||
      !claudeCredentialHealth(credentials).accessUsable ||
      isRejectedClaudeSource(source, credentials)
    ) {
      throw new Error(
        translate(
          'claudeAccount.signInBeforeLaunch',
          'Sign in to this Claude account again before launching.'
        )
      )
    }
    const seat = await prepareSeat()
    if (seat) {
      return seat
    }
    mkdirSync(path, { recursive: true, mode: 0o700 })
    if (process.platform === 'darwin') {
      await writeActiveClaudeKeychainCredentials(credentials, path)
    } else {
      writeFileAtomically(join(path, '.credentials.json'), credentials, { mode: 0o600 })
    }
    const oauth = readClaudeManagedAuthFile(authPath, 'oauth-account.json')
    writeFileAtomically(
      join(path, '.claude.json'),
      JSON.stringify({
        hasCompletedOnboarding: true,
        oauthAccount: oauth ? JSON.parse(oauth) : undefined
      }),
      { mode: 0o600 }
    )
    writeFileAtomically(
      join(path, '.omni-account-session.json'),
      JSON.stringify({
        accountId: account.id,
        authenticatedAt: account.lastAuthenticatedAt
      }),
      { mode: 0o600 }
    )
  }
  syncHomeClaudeConfigIntoAccountDirectory(path)
  for (const name of ['skills', 'agents', 'commands', 'plugins']) {
    const source = join(homedir(), '.claude', name)
    const destination = join(path, name)
    if (existsSync(source) && !existsSync(destination)) {
      symlinkSync(source, destination, process.platform === 'win32' ? 'junction' : 'dir')
    }
  }
  shareDefaultSessionRegistry(path)
  ensureClaudeHooksForRequestedEnv({ CLAUDE_CONFIG_DIR: path })
  return {
    configDir: path,
    runtime: 'host',
    wslDistro: null,
    wslLinuxConfigDir: null,
    envPatch: { CLAUDE_CONFIG_DIR: path },
    stripAuthEnv: true,
    provenance: `managed:${account.id}`
  }
}
