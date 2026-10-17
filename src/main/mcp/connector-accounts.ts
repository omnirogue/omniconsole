import { app } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { ConnectorAccount } from '../../shared/mcp-connectors'
import { assertOwnedHostCodexManagedHomePath } from '../codex-accounts/host-codex-managed-home-ownership'
import { prepareClaudeAccountSession } from '../claude-accounts/account-session-auth'
import { buildClaudeChildProcessEnv } from '../claude/claude-child-process-environment'
import { claudeConfigDirEnvPatch } from '../claude/claude-config-dir-pin'

export function connectorAccounts(settings: GlobalSettings): ConnectorAccount[] {
  return [
    { id: 'codex:default', provider: 'codex', label: 'Codex · system default', available: true },
    { id: 'claude:default', provider: 'claude', label: 'Claude · system default', available: true },
    ...settings.codexManagedAccounts.map((a): ConnectorAccount => ({
      id: `codex:${a.id}`,
      provider: 'codex',
      label: `Codex · ${a.email}${a.wslDistro ? ` · ${a.wslDistro}` : ''}`,
      available: a.managedHomeRuntime !== 'wsl'
    })),
    ...settings.claudeManagedAccounts.map((a): ConnectorAccount => ({
      id: `claude:${a.id}`,
      provider: 'claude',
      label: `Claude · ${a.email}${a.wslDistro ? ` · ${a.wslDistro}` : ''}`,
      available: a.managedAuthRuntime !== 'wsl'
    }))
  ]
}

export async function connectorAccountHome(
  settings: GlobalSettings,
  id: string
): Promise<{
  provider: 'claude' | 'codex'
  home: string
  env: NodeJS.ProcessEnv
}> {
  const account = connectorAccounts(settings).find((a) => a.id === id)
  if (!account || !account.available) {
    throw new Error(
      'Select an account on this computer. WSL accounts must be configured inside their distro.'
    )
  }
  const accountId = id.slice(id.indexOf(':') + 1)
  let home = join(homedir(), account.provider === 'codex' ? '.codex' : '.claude')
  if (accountId !== 'default' && account.provider === 'codex') {
    const a = settings.codexManagedAccounts.find((a) => a.id === accountId)!
    home = assertOwnedHostCodexManagedHomePath({
      candidatePath: a.managedHomePath,
      managedAccountsRoot: join(app.getPath('userData'), 'codex-accounts'),
      systemCodexHomePath: join(homedir(), '.codex'),
      expectedAccountId: a.id
    })
  }
  if (accountId !== 'default' && account.provider === 'claude') {
    const a = settings.claudeManagedAccounts.find((a) => a.id === accountId)!
    home = (await prepareClaudeAccountSession(a)).configDir
  }
  const env: NodeJS.ProcessEnv =
    account.provider === 'claude' && accountId !== 'default'
      ? buildClaudeChildProcessEnv({}, { scrubConfiguredChildSessionStamps: true })
      : { ...process.env }
  delete env.CODEX_HOME
  delete env.CLAUDE_CONFIG_DIR
  delete env.CLAUDECODE
  if (account.provider === 'codex') {
    env.CODEX_HOME = home
  } else if (accountId !== 'default') {
    Object.assign(env, claudeConfigDirEnvPatch(home, { env }))
  }
  return { provider: account.provider, home, env }
}

export function connectorConfigFile(account: {
  provider: 'claude' | 'codex'
  home: string
  env: NodeJS.ProcessEnv
}): string {
  return account.provider === 'codex'
    ? join(account.home, 'config.toml')
    : account.env.CLAUDE_CONFIG_DIR
      ? join(account.home, '.claude.json')
      : join(homedir(), '.claude.json')
}
