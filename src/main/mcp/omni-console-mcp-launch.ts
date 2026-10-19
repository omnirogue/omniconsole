import { hasTeamLaunchConnection, prepareTeamConnectorForLaunch } from '../omnisi-team/launch'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { mergeOmniConsoleMcpConfig, mergeOmniRogueUnifiedMcpConfig } from '../../shared/mcp-config'
import { mergeNotionMcpConfig } from '../../shared/notion-mcp'
import { isMcpConfigInspectionTextWithinLimit } from '../../shared/mcp-config-inspection-limits'
import { ClaudeRuntimePathResolver } from '../claude-accounts/runtime-paths'
import { resolveGrokHomeDir } from '../../shared/grok-session-paths'
import { writeFileAtomicallyIfUnchanged } from '../codex-accounts/fs-utils'
import {
  hasLaunchableOmniConsoleMcpToml,
  hasOmniRogueUnifiedMcpToml,
  isOmniConsoleDefaultToml,
  mergeOmniConsoleMcpToml,
  mergeOmniRogueUnifiedMcpToml,
  omniConsoleMcpTomlNeedsLedgerHeaders
} from './omni-console-mcp-toml'
import { hasLaunchableOmniConsoleMcp } from './omni-console-mcp-validation'
import { mergeNotionMcpToml } from './notion-mcp-toml'

export const OMNI_CONSOLE_MCP_PROVIDERS = ['claude', 'codex', 'gemini', 'grok', 'muse'] as const
export type OmniConsoleMcpProvider = (typeof OMNI_CONSOLE_MCP_PROVIDERS)[number]

type LaunchOptions = {
  signedIn: boolean
  excludeOmnisiTeam?: boolean
  provider: OmniConsoleMcpProvider
  env?: NodeJS.ProcessEnv
  cwd?: string
  home?: string
  /** Claude `headersHelper` command; set by the local spawn path only (never relay/WSL). */
  claudeHeadersHelper?: string
  /** When true, also auto-provision the unified OmniRogue + OmniSI MCP connectors. */
  includeOmniRogueUnified?: boolean
}

function readConfig(path: string): string | null {
  try {
    const content = readFileSync(path, 'utf8')
    if (!isMcpConfigInspectionTextWithinLimit(content)) {
      throw new Error('MCP config exceeds the inspection size limit.')
    }
    return content
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

function jsonConfig(content: string | null): Record<string, unknown> {
  const value: unknown = content === null ? {} : JSON.parse(content)
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('MCP config must be an object.')
  }
  return value as Record<string, unknown>
}

function workspaceConfigExists(options: LaunchOptions): boolean {
  if (!options.cwd || options.provider === 'muse') {
    return false
  }
  if (options.provider === 'grok') {
    let directory = options.cwd
    for (let depth = 0; depth < 64; depth += 1) {
      if (
        hasLaunchableOmniConsoleMcpToml(readConfig(join(directory, '.grok', 'config.toml')) ?? '')
      ) {
        return true
      }
      if (existsSync(join(directory, '.git')) || dirname(directory) === directory) {
        return false
      }
      directory = dirname(directory)
    }
    throw new Error('Grok project MCP discovery exceeded its directory limit.')
  }
  if (options.provider === 'codex') {
    return hasLaunchableOmniConsoleMcpToml(
      readConfig(join(options.cwd, `.${options.provider}`, 'config.toml')) ?? ''
    )
  }
  if (options.provider === 'gemini') {
    return hasLaunchableOmniConsoleMcp(
      jsonConfig(readConfig(join(options.cwd, '.gemini/settings.json')))
    )
  }
  return ['.mcp.json', '.claude/settings.json', '.claude/settings.local.json']
    .map((path) => hasLaunchableOmniConsoleMcp(jsonConfig(readConfig(join(options.cwd!, path)))))
    .some(Boolean)
}

/** Runs on the execution host after account selection, before the provider starts. */
export function prepareOmniConsoleMcpForLaunch(options: LaunchOptions): void {
  if (!options.signedIn && !hasTeamLaunchConnection()) {
    return
  }
  const env = { ...process.env, ...options.env }
  const home = options.home ?? env.HOME ?? env.USERPROFILE ?? homedir()
  const configPath =
    options.provider === 'codex'
      ? join(env.CODEX_HOME || join(home, '.codex'), 'config.toml')
      : options.provider === 'grok'
        ? join(resolveGrokHomeDir(env, home), 'config.toml')
        : options.provider === 'gemini'
          ? join(env.GEMINI_CLI_HOME || home, '.gemini', 'settings.json')
          : options.provider === 'muse'
            ? join(env.XDG_CONFIG_HOME || join(home, '.config'), 'muse', 'settings.json')
            : new ClaudeRuntimePathResolver().getRuntimePaths(env, home).configPath
  if (!options.excludeOmnisiTeam) {
    prepareTeamConnectorForLaunch(options.provider, configPath, options.env)
  }
  if (!options.signedIn) {
    return
  }
  // Why: Muse makes this folder when it is installed and signed in; a host without it has no Muse.
  if (options.provider === 'muse' && !existsSync(dirname(configPath))) {
    return
  }
  let path = configPath
  try {
    if (lstatSync(path).isSymbolicLink()) {
      path = realpathSync(path)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
  const previous = readConfig(path)
  if (options.provider === 'codex' || options.provider === 'grok') {
    hasLaunchableOmniConsoleMcpToml(previous ?? '')
  } else {
    hasLaunchableOmniConsoleMcp(jsonConfig(previous))
  }
  if (workspaceConfigExists(options)) {
    return
  }
  if (options.provider === 'codex' && env.CODEX_HOME && env.ORCA_CODEX_HOME === env.CODEX_HOME) {
    if (
      previous &&
      hasLaunchableOmniConsoleMcpToml(previous) &&
      !omniConsoleMcpTomlNeedsLedgerHeaders(previous, 'codex') &&
      (!options.includeOmniRogueUnified || hasOmniRogueUnifiedMcpToml(previous))
    ) {
      return
    }
    const system = readConfig(join(home, '.codex', 'config.toml')) ?? ''
    if (hasLaunchableOmniConsoleMcpToml(system) && !isOmniConsoleDefaultToml(system)) {
      return
    }
    // The managed-home hook preflight mirrors this source again inside the shell.
    prepareOmniConsoleMcpForLaunch({
      ...options,
      home,
      env: { ...env, CODEX_HOME: '', ORCA_CODEX_HOME: '' }
    })
  }
  let next: string
  if (options.provider === 'codex' || options.provider === 'grok') {
    hasLaunchableOmniConsoleMcpToml(previous ?? '')
    // Both connectors in one write, as on the JSON side.
    const baseToml = mergeNotionMcpToml(
      mergeOmniConsoleMcpToml(previous ?? '', true, options.provider)
    )
    next = options.includeOmniRogueUnified
      ? mergeOmniRogueUnifiedMcpToml(baseToml, true, options.provider)
      : baseToml
  } else {
    const config = jsonConfig(previous)
    if (options.provider === 'muse' && config.mcp_servers !== undefined) {
      // Why: Muse drops every server when `mcp_servers` sits beside `mcpServers`.
      return
    }
    const projects = config.projects as Record<string, unknown> | undefined
    const project = options.cwd ? projects?.[options.cwd] : undefined
    if (
      project &&
      typeof project === 'object' &&
      !Array.isArray(project) &&
      hasLaunchableOmniConsoleMcp(project as Record<string, unknown>)
    ) {
      return
    }
    hasLaunchableOmniConsoleMcp(config)
    // Why both here: the two connectors are provided the same way and share one write, so a
    // person who only lacks Notion still gets it without a second pass over the file. Each merge
    // returns its input unchanged when it has nothing to add, so the reference compare below
    // still means "nothing to write".
    const claudeHelperOptions =
      options.provider === 'claude' && options.claudeHeadersHelper
        ? { claudeHeadersHelper: options.claudeHeadersHelper }
        : {}
    const withConsole = mergeOmniConsoleMcpConfig(
      config,
      true,
      options.provider,
      claudeHelperOptions
    )
    const withUnified = options.includeOmniRogueUnified
      ? mergeOmniRogueUnifiedMcpConfig(withConsole, true, options.provider, claudeHelperOptions)
      : withConsole
    const merged =
      options.provider === 'muse'
        ? withUnified
        : mergeNotionMcpConfig(withUnified, options.provider)
    if (merged === config) {
      return
    }
    // Muse's own shape for a settings file it has not written yet.
    const file =
      previous === null && options.provider === 'muse' ? { schema_version: 1, ...merged } : merged
    next = `${JSON.stringify(file, null, 2)}\n`
  }
  if (next === previous) {
    return
  }
  mkdirSync(dirname(path), { recursive: true })
  if (
    !writeFileAtomicallyIfUnchanged(path, previous, next, {
      mode: previous === null ? 0o600 : statSync(path).mode
    })
  ) {
    throw new Error('MCP config changed during agent launch; retry the launch.')
  }
}
