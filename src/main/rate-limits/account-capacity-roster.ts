import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import type { ClaudeManagedAccount, CodexManagedAccount } from '../../shared/managed-account-types'
import type { CapacityEntry as Entry } from './claude-capacity-reading'
import type { AccountCapacityReadings } from './account-capacity-readings'
import {
  claudeSeatDirectories,
  readClaudeSeatCredentials,
  systemClaudeConfigDir
} from './claude-seat-directory'
import { claudeCredentialHealth } from './claude-credential-health'
import {
  resolveClaudeWorkingSources,
  claudeSourceUnavailableReason,
  isRejectedClaudeSource,
  type ClaudeWorkingSource
} from './claude-working-source'
import { discoverExistingAccountDirectories } from './existing-account-directories'
import { hasDiscoveredProfileCredentials } from './discovered-profile-credentials'
export type CapacityRoster = {
  claudeManagedAccounts: ClaudeManagedAccount[]
  codexManagedAccounts: CodexManagedAccount[]
  activeClaudeManagedAccountId: string | null
  activeCodexManagedAccountId: string | null
}

export async function resolveCapacityRoster(
  roster: CapacityRoster,
  readings: AccountCapacityReadings
) {
  const seats = claudeSeatDirectories()
  const claude: Entry[] = []
  for (const account of roster.claudeManagedAccounts.filter(
    (a) => a.managedAuthRuntime !== 'wsl'
  )) {
    let checking = false
    let sources: ClaudeWorkingSource[] = []
    try {
      sources = await resolveClaudeWorkingSources(account, seats)
    } catch {
      checking = true
    }
    const source = sources[0]
    const path = source?.path ?? join(account.managedAuthPath, 'session')
    claude.push({
      checking,
      accountId: account.id,
      email: account.email,
      detail: account.organizationName,
      path,
      sources,
      launchEnv: source ? { CLAUDE_CONFIG_DIR: path } : null,
      sourceLabel:
        source && (source.kind === 'seat' || source.kind === 'pool')
          ? `~/${relative(homedir(), path)}`
          : null,
      signedOutReason: claudeSourceUnavailableReason(account.id),
      reading: readings.get(JSON.stringify(['claude', path]))
    })
  }
  const systemPath = systemClaudeConfigDir()
  let systemChecking = false
  const systemRaw = await readClaudeSeatCredentials(systemPath).catch(() => {
    systemChecking = true
    return null
  })
  const health = claudeCredentialHealth(systemRaw)
  const systemSource: ClaudeWorkingSource = {
    ...health,
    path: systemPath,
    kind: 'seat',
    read: () => readClaudeSeatCredentials(systemPath)
  }
  const systemRejected = isRejectedClaudeSource(systemSource, systemRaw)
  claude.push({
    checking: systemChecking,
    accountId: null,
    signedOutReason: systemRejected ? 'revoked' : health.expired ? 'expired' : 'no-login',
    email: seats.find((seat) => seat.path === systemPath)?.email ?? null,
    path: systemPath,
    sources: health.accessUsable || health.refreshUsable ? [systemSource] : [],
    launchEnv:
      !systemRejected && (health.accessUsable || health.refreshUsable)
        ? { CLAUDE_CONFIG_DIR: systemPath }
        : null,
    reading: readings.get(JSON.stringify(['claude', systemPath]))
  })
  const profiles = discoverExistingAccountDirectories(homedir())
  const codex: Entry[] = []
  for (const account of [
    ...roster.codexManagedAccounts.filter((a) => a.managedHomeRuntime !== 'wsl'),
    null
  ]) {
    const path = account?.managedHomePath ?? join(homedir(), '.codex')
    const usable = await hasDiscoveredProfileCredentials({ provider: 'codex', path }).catch(
      () => false
    )
    codex.push({
      accountId: account?.id ?? null,
      email:
        account?.email ??
        profiles.find((p) => p.provider === 'codex' && p.path === path)?.email ??
        null,
      detail: account?.workspaceLabel,
      path,
      launchEnv: usable ? { CODEX_HOME: path } : null,
      reading: readings.get(JSON.stringify(['codex', path]))
    })
  }
  return { claude, codex }
}
