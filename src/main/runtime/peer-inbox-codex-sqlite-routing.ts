import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import { parseTomlKeyPath } from '../codex/config-toml-key-path'

const CONFIG_BYTES_LIMIT = 256 * 1024

// The durable owner record pins CODEX_HOME, but does not attest a separate SQLite root.
export function admitsPeerInboxCodexSqliteRouting(record: AgentSessionRecord): boolean {
  if (
    process.platform === 'win32' ||
    Object.keys(process.env).some((key) => key.toUpperCase() === 'CODEX_SQLITE_HOME') ||
    record.launchArgs?.some(
      (arg) => /^--(?:config|profile|cd)(?:=|$)/.test(arg) || /^-[cpC]/.test(arg)
    )
  ) {
    return false
  }

  for (const path of [
    join(record.accountHome.path, 'config.toml'),
    '/etc/codex/config.toml',
    '/etc/codex/requirements.toml'
  ]) {
    try {
      if (!lstatSync(path).isFile()) {
        return false
      }
      const { buffer } = readNodeFileSyncWithinLimit(path, CONFIG_BYTES_LIMIT)
      try {
        const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
        if (
          content
            .split(/\r?\n/)
            .some((line) => parseTomlKeyPath(line.trimStart())?.segments.includes('sqlite_home'))
        ) {
          return false
        }
      } finally {
        buffer.fill(0)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return false
      }
    }
  }
  return true
}
