import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { ACCOUNT_OAUTH_TOKEN_FILE_ENV, isPoolOAuthTokenFile } from '../shared/session-prep-account'

const MAX_TOKEN_BYTES = 8192

/**
 * Reads one estate pool slot token on the execution host. The path must be the pool layout,
 * resolve inside `<home>/.claude-accounts`, and be this user's private regular file: a token
 * another user could read or swap is not an account this host may launch with.
 */
export async function readPoolOAuthToken(file: string, home: string): Promise<string> {
  if (!isPoolOAuthTokenFile(file)) {
    throw new Error('Not a pool slot token file.')
  }
  const root = await realpath(join(home, '.claude-accounts'))
  const resolved = await realpath(file)
  if (!resolved.startsWith(root + sep)) {
    throw new Error('The pool slot token file resolves outside the account pool.')
  }
  const stat = await lstat(resolved)
  const uid = process.getuid?.()
  if (!stat.isFile() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) {
    throw new Error('The pool slot token file is not a private file of this user.')
  }
  if (stat.size > MAX_TOKEN_BYTES) {
    throw new Error('The pool slot token file is too large.')
  }
  const token = (await readFile(resolved, 'utf8')).trim()
  if (!token || /\s/.test(token)) {
    throw new Error('The pool slot token file is empty or malformed.')
  }
  return token
}

/** Setup-token slots of every pool under `<home>/.claude-accounts`, as their token file paths. */
export async function listPoolOAuthTokenFiles(home: string): Promise<string[]> {
  const root = join(home, '.claude-accounts')
  const files: string[] = []
  for (const pool of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!pool.isDirectory() || !/^[A-Za-z0-9_-]+$/.test(pool.name)) {
      continue
    }
    for (const slot of await readdir(join(root, pool.name), { withFileTypes: true }).catch(
      () => []
    )) {
      if (!slot.isDirectory() || !/^slot-\d+$/.test(slot.name)) {
        continue
      }
      const dir = join(root, pool.name, slot.name)
      // Why the marker check: refreshable-login slots and provider markers carry no setup token.
      const kind = (
        await readFile(join(dir, '.slot-kind'), 'utf8').catch(() => 'setup-token')
      ).trim()
      const file = join(dir, '.oauth-token')
      if (kind === 'setup-token' && (await lstat(file).catch(() => null))?.isFile()) {
        files.push(file)
      }
    }
  }
  return files.sort()
}

/** One-shot helpers spawn without a shell: swap the named token file for the token itself here. */
export async function applyPoolOAuthTokenFileEnv(
  env: Record<string, string>,
  home: string
): Promise<void> {
  const file = env[ACCOUNT_OAUTH_TOKEN_FILE_ENV]
  if (file === undefined) {
    return
  }
  delete env[ACCOUNT_OAUTH_TOKEN_FILE_ENV]
  env.CLAUDE_CODE_OAUTH_TOKEN = await readPoolOAuthToken(file, home)
}
