import type { TuiAgent } from '../../shared/tui-agent'
import { getDefaultWslDistro, getWslHome } from '../wsl'
import {
  OMNI_CONSOLE_MCP_PROVIDERS,
  prepareOmniConsoleMcpForLaunch
} from './omni-console-mcp-launch'
import { resolveOmniConsoleMcpWslPaths } from './omni-console-mcp-wsl'
import { retireTeamKnowledge } from '../team-knowledge/team-knowledge-retirement'
import { reportAppHealth } from '../app-health/app-health'
import { sanitizeCrashReportString } from '../../shared/crash-report-redaction'

export function prepareOmniConsoleMcpForPty(input: {
  internalSignedIn?: boolean
  env: NodeJS.ProcessEnv
  cwd?: string
  launchAgent?: TuiAgent
  isWsl?: boolean
  wslDistro?: string | null
  userDataPath?: string
  /**
   * The app-owned Claude `headersHelper` command on THIS machine. Only the local spawn path
   * passes it; the relay (SSH / paired hosts) never does, so a remote config keeps today's
   * shape and no local path is written to another host. Ignored for WSL, whose guest cannot
   * run a host path.
   */
  claudeHeadersHelper?: string | null
  /** When true, also auto-provision the unified OmniRogue + OmniSI MCP connectors. */
  includeOmniRogueUnified?: boolean
}): void {
  const providers = OMNI_CONSOLE_MCP_PROVIDERS.filter(
    (provider) => input.launchAgent === undefined || input.launchAgent === provider
  )
  if (providers.length === 0) {
    return
  }
  let paths: { env: NodeJS.ProcessEnv; cwd?: string; home?: string } = {
    env: input.env,
    cwd: input.cwd
  }
  if (input.isWsl) {
    const distro = input.wslDistro ?? getDefaultWslDistro()
    const home = distro ? getWslHome(distro) : null
    if (!distro || !home) {
      throw new Error('Cannot resolve the WSL home for MCP configuration.')
    }
    paths = resolveOmniConsoleMcpWslPaths({ env: input.env, cwd: input.cwd, distro, home })
  }
  const claudeHeadersHelper = input.isWsl ? null : input.claudeHeadersHelper
  for (const provider of providers) {
    try {
      prepareOmniConsoleMcpForLaunch({
        signedIn: input.internalSignedIn !== false,
        ...(input.isWsl ? { excludeOmnisiTeam: true } : {}),
        provider,
        ...paths,
        ...(provider === 'claude' && claudeHeadersHelper ? { claudeHeadersHelper } : {}),
        ...(input.includeOmniRogueUnified ? { includeOmniRogueUnified: true } : {})
      })
    } catch (error) {
      // Why: a config we could not write means this agent launches without the
      // connector and its memory; the console must see that, then the launch fails as before.
      reportAppHealth({
        feature: 'mcp_wiring',
        status: 'error',
        code: `${provider}_config_write_failed`,
        message: sanitizeCrashReportString(error instanceof Error ? error.message : String(error))
      })
      throw error
    }
  }
  if (input.userDataPath) {
    const report = retireTeamKnowledge({
      userDataPath: input.userDataPath,
      home: paths.home ?? paths.env.HOME ?? paths.env.USERPROFILE,
      env: paths.env
    })
    if (report.status === 'blocked') {
      console.warn('[team-knowledge]', report.reason)
    }
  }
}
