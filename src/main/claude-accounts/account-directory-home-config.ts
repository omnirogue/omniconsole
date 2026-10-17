import {
  copyFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readHooksJson } from '../agent-hooks/hooks-json-read'
import { writeHooksJson } from '../agent-hooks/installer-utils'

/** Settings an account must share with ~/.claude: an account is a credential, not a policy. */
export const HOME_CLAUDE_POLICY_SETTING_KEYS = ['permissions', 'env', 'autoCompactWindow'] as const

export type HomeClaudeConfigSync = {
  instructions: 'linked' | 'copied' | 'kept' | 'absent'
  policySettings: 'copied' | 'mirrored' | 'unchanged' | 'skipped'
}

/**
 * Why: a managed account directory is the CLAUDE_CONFIG_DIR of every session it runs, and
 * Claude reads that directory's CLAUDE.md as the user-global instructions. A one-time copy of
 * ~/.claude/CLAUDE.md froze the rules at account creation, and because Claude also walks the
 * working directory's ancestors (which reach ~/.claude/CLAUDE.md), the copy was loaded on top of
 * the live file. A symlink is deduplicated by real path, so the rules load once and stay current.
 */
export function syncHomeClaudeConfigIntoAccountDirectory(
  configDir: string,
  homeClaudeDir = join(homedir(), '.claude')
): HomeClaudeConfigSync {
  return {
    instructions: linkHomeClaudeInstructions(configDir, homeClaudeDir),
    policySettings: mirrorHomeClaudePolicySettings(configDir, homeClaudeDir)
  }
}

function linkHomeClaudeInstructions(
  configDir: string,
  homeClaudeDir: string
): HomeClaudeConfigSync['instructions'] {
  const source = join(homeClaudeDir, 'CLAUDE.md')
  const destination = join(configDir, 'CLAUDE.md')
  if (!existsSync(source)) {
    return 'absent'
  }
  const current =
    existsSync(destination) || isDanglingLink(destination) ? lstatSync(destination) : null
  if (current?.isSymbolicLink()) {
    if (readlinkSync(destination) === source) {
      return 'kept'
    }
    unlinkSync(destination)
  }
  const staleCopy = current !== null && !current.isSymbolicLink()
  const sameBytes = staleCopy && readFileSync(source).equals(readFileSync(destination))
  // Why: link under a temporary name first so a platform that refuses file links leaves the
  // existing copy untouched instead of half-replaced.
  const pending = `${destination}.${process.pid}.link`
  try {
    symlinkSync(source, pending, 'file')
  } catch {
    // Why: Windows refuses file symlinks without developer mode; a refreshed copy at least
    // keeps the rules current, although Claude then loads them once per path.
    if (sameBytes) {
      return 'kept'
    }
    copyFileSync(source, destination)
    return 'copied'
  }
  try {
    if (staleCopy) {
      // Why: the copy may carry hand edits; keep it beside the link unless it is identical.
      if (sameBytes) {
        unlinkSync(destination)
      } else {
        renameSync(destination, `${destination}.replaced-${backupStamp()}`)
      }
    }
    renameSync(pending, destination)
    return 'linked'
  } finally {
    if (isDanglingLink(pending) || existsSync(pending)) {
      unlinkSync(pending)
    }
  }
}

function mirrorHomeClaudePolicySettings(
  configDir: string,
  homeClaudeDir: string
): HomeClaudeConfigSync['policySettings'] {
  const sourcePath = join(homeClaudeDir, 'settings.json')
  const destinationPath = join(configDir, 'settings.json')
  if (!existsSync(sourcePath)) {
    return 'skipped'
  }
  if (!existsSync(destinationPath)) {
    copyFileSync(sourcePath, destinationPath)
    return 'copied'
  }
  const source = readHooksJson(sourcePath)
  const destination = readHooksJson(destinationPath)
  // Why: an unreadable side is not authoritative; never rewrite settings from a guess.
  if (!source || !destination) {
    return 'skipped'
  }
  let changed = false
  for (const key of HOME_CLAUDE_POLICY_SETTING_KEYS) {
    if (JSON.stringify(source[key]) === JSON.stringify(destination[key])) {
      continue
    }
    if (source[key] === undefined) {
      delete destination[key]
    } else {
      destination[key] = source[key]
    }
    changed = true
  }
  if (!changed) {
    return 'unchanged'
  }
  writeHooksJson(destinationPath, destination, { preserveMode: true })
  return 'mirrored'
}

function isDanglingLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

function backupStamp(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
}
