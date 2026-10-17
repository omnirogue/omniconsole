import { homedir } from 'node:os'
import {
  findFirstExecutable,
  getBaseVersionManagerDirectories,
  getExecutableNames,
  getNvmVersionDirectories,
  splitPath,
  type ResolveCommandOptions
} from './node-cli-command-resolution'

/** Homebrew/apt shims often trail the user's nvm or ~/.local install. */
export function isStalePackageManagerCliPath(
  candidate: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const normalized = candidate.replaceAll('\\', '/')
  if (platform === 'darwin') {
    return (
      normalized.includes('/opt/homebrew/') ||
      normalized.includes('/usr/local/Cellar/') ||
      normalized.includes('/usr/local/bin/')
    )
  }
  if (platform === 'linux') {
    return normalized.startsWith('/usr/bin/') || normalized.includes('/usr/local/bin/')
  }
  return false
}

export function resolveCodexCommand(options: ResolveCommandOptions = {}): string {
  const platform = options.platform ?? process.platform
  const executableNames = getExecutableNames(platform, 'codex')
  const pathEnv = options.pathEnv ?? process.env.PATH ?? process.env.Path ?? null
  const homePath = options.homePath ?? homedir()
  const pathCandidate = findFirstExecutable(platform, splitPath(pathEnv), executableNames)
  const userCandidate = findFirstExecutable(
    platform,
    [...getNvmVersionDirectories(homePath), ...getBaseVersionManagerDirectories(platform, homePath)],
    executableNames
  )
  // Why: GUI PATH often hits a Homebrew/npm shim to a stale Codex (measured:
  // /opt/homebrew/bin/codex -> nvm v22.22.0 @ 0.152 while ~/.local/bin is 0.154).
  // That launch then fails gpt-6-astra with "requires a newer version of Codex".
  if (
    pathCandidate &&
    userCandidate &&
    pathCandidate !== userCandidate &&
    isStalePackageManagerCliPath(pathCandidate, platform)
  ) {
    return userCandidate
  }
  return pathCandidate ?? userCandidate ?? 'codex'
}
