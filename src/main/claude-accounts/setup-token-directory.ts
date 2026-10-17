import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const CLAUDE_SETUP_TOKEN_FILE = '.oauth-token'
export const CLAUDE_SETUP_TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN'

/**
 * A Claude config directory prepared with `claude setup-token` authenticates through
 * the long-lived token beside it, not through a browser login. When a launch asks for
 * such a directory (an account profile), hand the CLI that token for this process only.
 * Nothing is stored: the file stays where the person put it and is read at spawn time.
 */
export function applyClaudeSetupTokenDirectory(
  env: Record<string, string>,
  requestedEnv: Record<string, string> | undefined,
  readToken: (path: string) => string | null = readTokenFile
): boolean {
  const configDir = requestedEnv?.CLAUDE_CONFIG_DIR?.trim()
  // Why requested, not inherited: only a directory this launch explicitly named may
  // supply a token; an ambient CLAUDE_CONFIG_DIR in OmniConsole's own environment must not.
  if (!configDir || env.CLAUDE_CONFIG_DIR !== configDir || env[CLAUDE_SETUP_TOKEN_ENV]) {
    return false
  }
  const token = readToken(join(configDir, CLAUDE_SETUP_TOKEN_FILE))
  if (!token) {
    return false
  }
  env[CLAUDE_SETUP_TOKEN_ENV] = token
  return true
}

function readTokenFile(path: string): string | null {
  try {
    const token = readFileSync(path, 'utf8').trim()
    return token.length > 0 ? token : null
  } catch {
    return null
  }
}
