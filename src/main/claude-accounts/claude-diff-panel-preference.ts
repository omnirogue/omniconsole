import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { renameFileWithWindowsRetry } from '../codex-accounts/fs-utils'

/**
 * The global config files a Claude launch may read, as Claude Code 2.1.281 resolves them: a legacy
 * `<config dir>/.config.json` when present, else `.claude.json` in CLAUDE_CONFIG_DIR, else in the
 * home directory. Why both for the default `~/.claude`: shell wrappers that export
 * CLAUDE_CONFIG_DIR=~/.claude move the file there, and the typed `claude` command runs through them.
 */
export function claudeGlobalConfigPaths(
  configDir: string,
  env: Record<string, string | undefined>,
  home: string = homedir()
): string[] {
  const dir = resolve(configDir)
  const legacy = join(dir, '.config.json')
  if (existsSync(legacy)) {
    return [legacy]
  }
  const name = `.claude${env.CLAUDE_CODE_CUSTOM_OAUTH_URL ? '-custom-oauth' : ''}.json`
  return dir === resolve(home, '.claude') ? [join(dir, name), join(home, name)] : [join(dir, name)]
}

/**
 * The config text with the diff pane recorded as closed, or null when there is nothing to change:
 * already closed, or not a JSON object (a corrupted config is the person's to fix).
 */
export function closedDiffPanelConfigText(text: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null
  }
  const config = parsed as Record<string, unknown>
  return config.diffSidebarOpen === false
    ? null
    : `${JSON.stringify({ ...config, diffSidebarOpen: false }, null, 2)}\n`
}

type FileIdentity = { ino: number; size: number; mtimeMs: number }
type ClaudeConfigFile = { next: string | null; mode: number; identity: FileIdentity }

function fileIdentity(path: string): (FileIdentity & { mode: number }) | null {
  try {
    const { ino, size, mtimeMs, mode } = statSync(path)
    return { ino, size, mtimeMs, mode: mode & 0o777 }
  } catch {
    return null
  }
}

const sameIdentity = (a: FileIdentity | null, b: FileIdentity | null): boolean =>
  a !== null && b !== null && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs

function readClaudeConfig(path: string): ClaudeConfigFile | null {
  const before = fileIdentity(path)
  if (!before) {
    return null
  }
  try {
    const next = closedDiffPanelConfigText(readFileSync(path, 'utf-8'))
    // Why: a file that changed while it was read is not a base to rewrite from.
    if (!sameIdentity(before, fileIdentity(path))) {
      return null
    }
    return { next, mode: before.mode, identity: before }
  } catch {
    return null
  }
}

/** Claude saves this file holding proper-lockfile's `<file>.lock` directory; take the same lock. */
function withClaudeConfigLock(path: string, write: () => boolean): boolean {
  const lock = `${path}.lock`
  try {
    mkdirSync(lock)
  } catch {
    // Why skip: a running Claude is saving the file; the next launch records the preference.
    return false
  }
  try {
    return write()
  } finally {
    try {
      rmdirSync(lock)
    } catch {
      // Already gone; there is nothing else to release.
    }
  }
}

/**
 * Replace the file only if it is still the one that was read. Why not move it aside first (the
 * guarded write the account files use): a Claude starting in that window would find no config
 * and treat itself as a fresh install.
 */
function replaceIfUnchanged(path: string, read: ClaudeConfigFile, contents: string): boolean {
  const tmpPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    // Why the file's own mode: it holds the account, so a rewrite must not loosen it past 0600.
    writeFileSync(tmpPath, contents, { encoding: 'utf-8', mode: read.mode })
    if (!sameIdentity(read.identity, fileIdentity(path))) {
      return false
    }
    renameFileWithWindowsRetry(tmpPath, path)
    return true
  } finally {
    rmSync(tmpPath, { force: true })
  }
}

function closeDiffPanelIn(path: string): boolean {
  // Why the resolved file: a symlinked config (a managed one, say) must stay a symlink; replacing
  // the link itself would cut Claude off from the file it points at.
  let target: string
  try {
    target = realpathSync(path)
  } catch {
    return false
  }
  if (!readClaudeConfig(target)?.next) {
    return false
  }
  // Why the path's own lock: Claude locks the path it opens, not the file the link resolves to.
  return withClaudeConfigLock(path, () => {
    // Why read again: a Claude save may have landed between the check and the lock.
    const current = readClaudeConfig(target)
    return current?.next ? replaceIfUnchanged(target, current, current.next) : false
  })
}

/**
 * Keep Claude Code's own diff pane shut until the person runs /diff (Sal, 2026-09-24: no empty or
 * "Diff unavailable" pane taking half the conversation). Claude opens that pane by itself on a
 * session's first edit whenever the terminal is wide enough, unless its global config says the
 * person closed it (`diffSidebarOpen: false`); /diff still opens it for that session. Writes only
 * into existing, readable configs and never touches any other key. Returns how many it changed.
 */
export function keepClaudeDiffPanelClosed(
  configDir: string,
  env: Record<string, string | undefined>,
  home: string = homedir()
): number {
  return claudeGlobalConfigPaths(configDir, env, home).filter(closeDiffPanelIn).length
}
