import type { TeamConfigTarget } from './config-targets'
import { dirname } from 'node:path'
import type { OmniConsoleMcpProvider } from '../mcp/omni-console-mcp-launch'
import { TEAM_AUTH_ENV, type TeamConnection } from './connection'
import {
  rememberConnectorChoice,
  updateTeamConnectorConfig
} from '../mcp/connector-config-preservation'

let connection: TeamConnection | null = null
let remember: ((target: TeamConfigTarget) => void) | undefined
export function hasTeamLaunchConnection(): boolean {
  return connection !== null
}
export function setTeamLaunchConnection(
  value: TeamConnection | null,
  onTarget?: (target: TeamConfigTarget) => void
): void {
  connection = value
  remember = onTarget
}

/** Installed only on this execution host; credentials never cross SSH or WSL boundaries. */
export function prepareTeamConnectorForLaunch(
  provider: OmniConsoleMcpProvider,
  file: string,
  env?: NodeJS.ProcessEnv
): void {
  if (!connection || !env || provider === 'muse') {
    return
  }
  remember?.({ file, provider, ...(provider === 'codex' ? { home: dirname(file) } : {}) })
  updateTeamConnectorConfig(file, provider, connection.server)
  if (provider === 'codex') {
    rememberConnectorChoice(dirname(file), 'omnisi-team', 'keep')
  }
  env[TEAM_AUTH_ENV] = `Bearer ${connection.key}`
}
