import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { encodeClaudeProjectPaths } from '../ai-vault/claude-project-dir-encoding'

/** Who a thread memory folder belongs to; kept in its thread.json. */
export type ClaudeThreadMemoryOwner = {
  projectFolderId: string
  dispatchId?: string
}

type ThreadRecord = ClaudeThreadMemoryOwner & { repoMemoryDir: string | null; createdAt: string }

export function claudeThreadMemoryRoot(): string {
  return join(getAppEnvironment().getPath('userData'), 'claude-thread-memory')
}

/** The repo's shared Claude memory folder under this config dir, when it has an index. */
function findRepoMemoryDir(configDir: string, repoPath: string): string | null {
  for (const slug of encodeClaudeProjectPaths(repoPath)) {
    const dir = join(configDir, 'projects', slug, 'memory')
    if (existsSync(join(dir, 'MEMORY.md'))) {
      return dir
    }
  }
  return null
}

function writeThreadSettings(dir: string, repoMemoryDir: string | null): string {
  const settingsPath = join(dir, 'settings.json')
  const settings = {
    autoMemoryDirectory: join(dir, 'memory'),
    // Why: an unattended worker would stall on a read prompt for the shared memory it is pointed at.
    ...(repoMemoryDir ? { permissions: { additionalDirectories: [repoMemoryDir] } } : {})
  }
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
  return settingsPath
}

/**
 * A project thread's own Claude memory folder: Claude reads and writes `memory/` instead of the
 * repo's shared folder, whose index it is pointed at and opens only when it needs it.
 */
export function createClaudeThreadMemory(args: {
  owner: ClaudeThreadMemoryOwner
  repoPath: string | null
  configDir: string
  root?: string
}): { key: string; settingsPath: string } {
  const key = randomUUID()
  const dir = join(args.root ?? claudeThreadMemoryRoot(), key)
  mkdirSync(join(dir, 'memory'), { recursive: true, mode: 0o700 })
  const repoMemoryDir = args.repoPath ? findRepoMemoryDir(args.configDir, args.repoPath) : null
  const record: ThreadRecord = {
    ...args.owner,
    repoMemoryDir,
    createdAt: new Date().toISOString()
  }
  writeFileSync(join(dir, 'thread.json'), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  if (repoMemoryDir) {
    const index = join(repoMemoryDir, 'MEMORY.md')
    writeFileSync(
      join(dir, 'memory', 'MEMORY.md'),
      `- [Shared repo memory](<${index}>) — what earlier sessions learned about this repo; read it when you need it, don't edit it.\n`,
      { mode: 0o600 }
    )
  }
  return { key, settingsPath: writeThreadSettings(dir, repoMemoryDir) }
}

/**
 * The `--settings` flag for a local Claude project thread, or none: other agents, SSH, WSL and
 * Windows POSIX-shell launches keep the shared memory, and so does a thread whose folder can't
 * be created.
 */
export function claudeThreadMemoryFlags(args: {
  owner: ClaudeThreadMemoryOwner | undefined
  agent: string
  local: boolean
  repoPath: string | null
  configDir: string
  root?: string
}): [string, string][] | undefined {
  if (!args.owner || args.agent !== 'claude' || !args.local) {
    return undefined
  }
  try {
    return [['--settings', createClaudeThreadMemory({ ...args, owner: args.owner }).settingsPath]]
  } catch (error) {
    console.warn('[claude-thread-memory] using the shared memory:', error)
    return undefined
  }
}

const SETTINGS_IN_COMMAND = /claude-thread-memory[\\/]([0-9a-f-]{36})[\\/]settings\.json/

/** Why: Claude refuses to start when a `--settings` file is missing, and a resumed thread's saved
 *  command still names its own. Best-effort; leaves any other command alone. */
export function restoreClaudeThreadMemorySettings(
  command: string | undefined,
  root?: string
): void {
  const key = command?.match(SETTINGS_IN_COMMAND)?.[1]
  if (!command || !key) {
    return
  }
  try {
    const dir = join(root ?? claudeThreadMemoryRoot(), key)
    const settingsPath = join(dir, 'settings.json')
    if (!command.includes(settingsPath) || existsSync(settingsPath)) {
      return
    }
    mkdirSync(join(dir, 'memory'), { recursive: true, mode: 0o700 })
    writeThreadSettings(dir, readRepoMemoryDir(dir))
  } catch (error) {
    console.warn('[claude-thread-memory] could not restore settings:', error)
  }
}

function readRepoMemoryDir(dir: string): string | null {
  try {
    const record = JSON.parse(
      readFileSync(join(dir, 'thread.json'), 'utf8')
    ) as Partial<ThreadRecord>
    return typeof record.repoMemoryDir === 'string' ? record.repoMemoryDir : null
  } catch {
    return null
  }
}
