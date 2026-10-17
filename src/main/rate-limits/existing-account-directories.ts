import { parseWslUncPath } from '../../shared/wsl-paths'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { basename, join } from 'node:path'

import { readCodexAuthIdentity } from '../codex-accounts/codex-auth-identity'

export type ExistingAccountDirectory = {
  provider: 'claude' | 'codex'
  runtime?: 'host' | 'wsl'
  wslDistro?: string | null
  path: string
  email?: string | null
  providerAccountId?: string | null
  workspaceAccountId?: string | null
  organizationUuid?: string | null
}

function profileIdentity(
  provider: 'claude' | 'codex',
  path: string,
  home: string
): Partial<ExistingAccountDirectory> {
  try {
    if (provider === 'codex') {
      return readCodexAuthIdentity(readFileSync(join(path, 'auth.json'), 'utf8')) ?? { email: null }
    }
    const file =
      path === join(home, '.claude') && !existsSync(join(path, '.claude.json'))
        ? join(home, '.claude.json')
        : join(path, '.claude.json')
    const account = JSON.parse(readFileSync(file, 'utf8')).oauthAccount
    return {
      email: typeof account?.emailAddress === 'string' ? account.emailAddress : null,
      ...(typeof account?.organizationUuid === 'string'
        ? { organizationUuid: account.organizationUuid }
        : {})
    }
  } catch {
    return { email: null }
  }
}

function directories(parent: string): string[] {
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => join(parent, entry.name))
      .sort()
  } catch {
    return []
  }
}

/** Bounded discovery of CLI profile conventions; never walk transcripts or backup trees. */
export function discoverExistingAccountDirectories(home: string): ExistingAccountDirectory[] {
  const found: ExistingAccountDirectory[] = []
  const seen = new Set<string>()
  const add = (provider: 'claude' | 'codex', path: string): void => {
    const hasProfile =
      provider === 'codex'
        ? existsSync(join(path, 'auth.json'))
        : existsSync(join(path, '.credentials.json')) ||
          existsSync(join(path, '.claude.json')) ||
          (path === join(home, '.claude') && existsSync(join(home, '.claude.json')))
    if (!hasProfile) {
      return
    }
    try {
      const canonical = realpathSync(path)
      const key = `${provider}:${canonical}`
      if (!seen.has(key)) {
        seen.add(key)
        const wsl = parseWslUncPath(canonical)
        found.push({
          provider,
          path: canonical,
          ...profileIdentity(provider, canonical, home),
          ...(wsl ? { runtime: 'wsl' as const, wslDistro: wsl.distro } : {})
        })
      }
    } catch {
      // A removed profile can be discovered again on the next import.
    }
  }
  add('claude', join(home, '.claude'))
  add('codex', join(home, '.codex'))
  for (const path of directories(home)) {
    const name = basename(path)
    if (/^\.claude-account-[1-9]\d*$/.test(name) || /^\.claude-twin[\w-]*$/.test(name)) {
      add('claude', path)
    }
    if (/^\.codex-(second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)$/.test(name)) {
      add('codex', path)
    }
  }
  for (const provider of ['claude', 'codex'] as const) {
    for (const path of directories(join(home, `.${provider}-accounts`))) {
      if (/(^|[/\\])(backups?|archive)$/i.test(path)) {
        continue
      }
      add(provider, path)
      if (provider === 'claude') {
        for (const slot of directories(path)) {
          if (/[/\\]slot-[1-9]\d*$/.test(slot)) {
            add(provider, slot)
          }
        }
      }
    }
  }
  return found
}
