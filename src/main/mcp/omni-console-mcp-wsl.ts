import { win32 } from 'node:path'
import { parseWslUncPath, toWindowsWslPath } from '../../shared/wsl-paths'

export function resolveOmniConsoleMcpWslPaths(input: {
  env: NodeJS.ProcessEnv
  cwd?: string
  distro: string
  home: string
}): { env: NodeJS.ProcessEnv; cwd?: string; home: string } {
  const homeInfo = parseWslUncPath(input.home)
  if (!homeInfo || homeInfo.distro.toLowerCase() !== input.distro.toLowerCase()) {
    throw new Error('Cannot resolve the WSL home for MCP configuration.')
  }
  const pathOnHost = (value: string | undefined, fallback?: string): string | undefined => {
    if (!value) {
      return fallback
    }
    return value.startsWith('/') && !value.startsWith('//')
      ? toWindowsWslPath(value, input.distro)
      : value
  }
  return {
    home: input.home,
    cwd: pathOnHost(input.cwd),
    env: {
      ...input.env,
      HOME: input.home,
      CODEX_HOME: pathOnHost(input.env.CODEX_HOME, win32.join(input.home, '.codex')),
      ORCA_CODEX_HOME: pathOnHost(input.env.ORCA_CODEX_HOME),
      CLAUDE_CONFIG_DIR: pathOnHost(input.env.CLAUDE_CONFIG_DIR, ''),
      GROK_HOME: pathOnHost(input.env.GROK_HOME, win32.join(input.home, '.grok')),
      GEMINI_CLI_HOME: pathOnHost(input.env.GEMINI_CLI_HOME, input.home),
      XDG_CONFIG_HOME: pathOnHost(input.env.XDG_CONFIG_HOME, '')
    }
  }
}
