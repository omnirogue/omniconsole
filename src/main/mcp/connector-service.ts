import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type * as SmolToml from 'smol-toml' with { 'resolution-mode': 'import' }
import type { GlobalSettings } from '../../shared/global-settings-types'
import {
  validateConnectorDefinition,
  validateConnectorName,
  type ConnectorAction,
  type ConnectorDefinition,
  type ConnectorStatus,
  type ConnectorSummary
} from '../../shared/mcp-connectors'
import { runProcess } from '../../shared/child-process/run-process'
import {
  resolveClaudeCommand,
  resolveCodexCommand,
  withCliRuntimeOnPath
} from '../codex-cli/command'
import { runClaudeConnectorLoginInPty } from './claude-connector-login-pty'
import { connectorAccountHome, connectorConfigFile } from './connector-accounts'
import {
  rememberConnectorChoice,
  persistRemovedConnector,
  restoreClaudeConnectorChoice
} from './connector-config-preservation'
import { checkCodexConnector } from './codex-connector-status'
import { isOmniConsoleMcpNameUnavailable } from '../../shared/omni-console-mcp-alias'
import { MCP_CONFIG_INSPECTION_MAX_SERVERS } from '../../shared/mcp-config-inspection-limits'

const { parse } = require('smol-toml') as typeof SmolToml
const TIMED_OUT = 'The connector operation timed out. Refresh its status before retrying.'
const PROVIDER_FAILED =
  'The provider could not complete this operation. Check its MCP configuration and try again.'

export class ConnectorService {
  private readonly busy = new Set<string>()
  constructor(private readonly settings: () => GlobalSettings) {}

  async list(id: string): Promise<ConnectorSummary[]> {
    const account = await connectorAccountHome(this.settings(), id)
    const file = connectorConfigFile(account)
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw new Error('The account configuration could not be read.')
    }
    if (text.length > 2 * 1024 * 1024) {
      throw new Error('The account configuration is too large to inspect.')
    }
    let config: Record<string, unknown>
    try {
      config = account.provider === 'codex' ? parse(text) : JSON.parse(text)
    } catch {
      throw new Error('The account configuration is invalid. Repair it before adding connectors.')
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('The account configuration must be an object.')
    }
    const servers = config[account.provider === 'codex' ? 'mcp_servers' : 'mcpServers']
    if (servers === undefined) {
      return []
    }
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
      throw new Error('The MCP server collection is invalid. Repair it before adding connectors.')
    }
    if (Object.keys(servers).length > MCP_CONFIG_INSPECTION_MAX_SERVERS) {
      throw new Error('There are too many MCP servers to inspect in this account.')
    }
    return Object.entries(servers)
      .filter(([, raw]) => {
        const server = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
        return !(server.enabled === false && server.command === 'omni-connector-removed')
      })
      .map(([name, raw]) => {
        const server = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
        return {
          name,
          transport:
            typeof server.url === 'string'
              ? 'http'
              : typeof server.command === 'string'
                ? 'stdio'
                : 'unknown',
          enabled:
            server.enabled !== false &&
            server.disabled !== true &&
            !isOmniConsoleMcpNameUnavailable(config, name)
        }
      })
  }

  async add(id: string, value: ConnectorDefinition): Promise<void> {
    const definition = validateConnectorDefinition(value)
    await this.exclusive(id, async () => {
      if ((await this.list(id)).some((server) => server.name === definition.name)) {
        throw new Error('A connector with this name already exists in this account.')
      }
      const account = await connectorAccountHome(this.settings(), id)
      const { provider, home } = account
      if (id === 'codex:default') {
        for (const managed of this.settings().codexManagedAccounts ?? []) {
          if (managed.managedHomeRuntime === 'wsl') {
            continue
          }
          const targetId = `codex:${managed.id}`
          const target = await connectorAccountHome(this.settings(), targetId)
          const exists = (await this.list(targetId)).some(
            (server) => server.name === definition.name
          )
          rememberConnectorChoice(target.home, definition.name, exists ? 'keep' : 'remove')
        }
      }
      if (provider === 'codex') {
        try {
          const config = parse(await readFile(join(home, 'config.toml'), 'utf8'))
          const servers = config.mcp_servers as SmolToml.TomlTable | undefined
          const entry = servers?.[definition.name] as SmolToml.TomlTable | undefined
          if (entry?.enabled === false && entry.command === 'omni-connector-removed') {
            await this.command(id, ['mcp', 'remove', definition.name], 30_000)
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error
          }
        }
      }
      rememberConnectorChoice(home, definition.name, 'keep')
      const args =
        provider === 'codex'
          ? [
              'mcp',
              'add',
              definition.name,
              ...(definition.transport === 'http'
                ? ['--url', definition.url!]
                : ['--', definition.command!, ...definition.args!])
            ]
          : [
              'mcp',
              'add-json',
              '--scope',
              'user',
              definition.name,
              JSON.stringify(
                definition.transport === 'http'
                  ? { type: 'http', url: definition.url }
                  : { type: 'stdio', command: definition.command, args: definition.args }
              )
            ]
      try {
        await this.command(id, args, 180_000)
      } catch {
        throw new Error(
          'Setup did not finish. The provider may have saved the connector before sign-in failed. Refresh this account and check its status before retrying.'
        )
      }
      if (provider === 'claude') {
        restoreClaudeConnectorChoice(connectorConfigFile(account), definition.name)
      }
    })
  }

  async action(id: string, name: string, action: ConnectorAction): Promise<ConnectorStatus> {
    validateConnectorName(name)
    if (!['check', 'login', 'reconnect', 'remove'].includes(action)) {
      throw new Error('Unknown connector action.')
    }
    return this.exclusive(id, async () => {
      const server = (await this.list(id)).find((server) => server.name === name)
      if (!server) {
        throw new Error('This connector no longer exists. Refresh the list.')
      }
      const account = await connectorAccountHome(this.settings(), id)
      const { provider, home } = account
      if (action === 'remove') {
        await this.command(
          id,
          ['mcp', 'remove', ...(provider === 'claude' ? ['--scope', 'user'] : []), name],
          30_000
        )
        rememberConnectorChoice(home, name, 'remove')
        persistRemovedConnector(home, provider, connectorConfigFile(account), name)
        return 'configured'
      }
      if (!server.enabled) {
        return 'unavailable'
      }
      if (action === 'login' || action === 'reconnect') {
        if (server.transport !== 'http') {
          throw new Error('Local-command connectors do not use browser sign-in.')
        }
        if (action === 'reconnect') {
          await this.command(id, ['mcp', 'logout', name], 30_000)
        }
        await (provider === 'claude'
          ? this.claudeLogin(id, name)
          : this.command(id, ['mcp', 'login', name], 180_000))
      }
      if (provider === 'claude') {
        const output = await this.command(id, ['mcp', 'get', name], 30_000)
        if (/needs authentication|not authenticated/i.test(output)) {
          return 'needs-sign-in'
        }
        return /(?:✓|✔).*Connected|Status:\s*Connected/i.test(output) ? 'connected' : 'unavailable'
      }
      return checkCodexConnector(home, name)
    })
  }

  private async command(id: string, args: string[], timeoutMs: number): Promise<string> {
    const account = await connectorAccountHome(this.settings(), id)
    const program = account.provider === 'codex' ? resolveCodexCommand() : resolveClaudeCommand()
    const result = await runProcess({
      program,
      args,
      cwd: homedir(),
      env: withCliRuntimeOnPath(program, account.env),
      timeoutMs,
      maxOutputBytes: 256 * 1024,
      terminationBarrier: true
    })
    if (result.timedOut) {
      throw new Error(TIMED_OUT)
    }
    if (result.code !== 0 || result.stdoutTruncated || result.stderrTruncated) {
      // Provider output may contain tokens, headers, or authorization URLs.
      throw new Error(PROVIDER_FAILED)
    }
    return result.stdout
  }

  private async claudeLogin(id: string, name: string): Promise<void> {
    const account = await connectorAccountHome(this.settings(), id)
    const program = resolveClaudeCommand()
    const result = await runClaudeConnectorLoginInPty({
      program,
      name,
      cwd: homedir(),
      env: withCliRuntimeOnPath(program, account.env),
      timeoutMs: 180_000
    })
    if (result.timedOut) {
      throw new Error(TIMED_OUT)
    }
    if (result.code !== 0) {
      throw new Error(PROVIDER_FAILED)
    }
  }

  private async exclusive<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (this.busy.has(id)) {
      throw new Error('Another connector operation is running for this account.')
    }
    this.busy.add(id)
    try {
      return await operation()
    } finally {
      this.busy.delete(id)
    }
  }
}
