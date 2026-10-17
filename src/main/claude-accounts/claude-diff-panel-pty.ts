import { homedir } from 'node:os'
import { join } from 'node:path'
import type { TuiAgent } from '../../shared/tui-agent'
import { resolveOmniConsoleMcpWslPaths } from '../mcp/omni-console-mcp-wsl'
import { getDefaultWslDistro, getWslHome } from '../wsl'
import { keepClaudeDiffPanelClosed } from './claude-diff-panel-preference'

const CLAUDE_FORMAT_AGENTS: ReadonlySet<TuiAgent> = new Set(['claude', 'claude-agent-teams'])

/**
 * Runs on the execution host for a Claude launch (a local PTY, or the relay's on an SSH host)
 * before Claude starts: keeps Claude's own diff pane shut in the global config this launch will
 * read, found from the launch's own CLAUDE_CONFIG_DIR and home with Claude's filename rules. WSL
 * shells resolve their distro's paths the way the MCP preparation does. Never fails a spawn.
 */
export function keepClaudeDiffPanelClosedForPty(input: {
  env: NodeJS.ProcessEnv
  launchAgent?: TuiAgent
  isWsl?: boolean
  wslDistro?: string | null
}): void {
  if (!input.launchAgent || !CLAUDE_FORMAT_AGENTS.has(input.launchAgent)) {
    return
  }
  try {
    let env: NodeJS.ProcessEnv = { ...process.env, ...input.env }
    let home = env.HOME || env.USERPROFILE || homedir()
    if (input.isWsl) {
      const distro = input.wslDistro ?? getDefaultWslDistro()
      const wslHome = distro ? getWslHome(distro) : null
      if (!distro || !wslHome) {
        return
      }
      const paths = resolveOmniConsoleMcpWslPaths({ env: input.env, distro, home: wslHome })
      env = paths.env
      home = paths.home
    }
    const configDir = env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude')
    keepClaudeDiffPanelClosed(configDir, env, home)
  } catch {
    // Best effort: Claude's own diff pane still closes with /diff.
  }
}
