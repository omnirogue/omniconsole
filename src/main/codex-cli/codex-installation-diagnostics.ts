import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import { resolveCliCommand, withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import { resolveLoginShellEnvironment } from '../startup/login-shell-environment'

import type { CodexInstallationDiagnostics } from '../../shared/codex-installation-diagnostics-types'

export type { CodexInstallationDiagnostics } from '../../shared/codex-installation-diagnostics-types'

export type CodexInstallationDiagnosticsDeps = {
  resolveEnvironment?: () => Promise<NodeJS.ProcessEnv>
  runVersion?: (program: string, env: NodeJS.ProcessEnv) => Promise<string | null>
  runNpmPrefix?: (env: NodeJS.ProcessEnv) => Promise<string | null>
  realpath?: (path: string) => string | null
  platform?: NodeJS.Platform
  now?: () => number
}

const PROBE_TIMEOUT_MS = 8_000
const CACHE_TTL_MS = 60_000

function parseVersion(stdout: string): string | null {
  return /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/.exec(stdout)?.[1] ?? null
}

async function runVersionProbe(program: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const result = await runProcess({
      program,
      args: ['--version'],
      // Why: a resolved CLI must run under its sibling node, or a native module
      // dies on NODE_MODULE_VERSION and the probe reads as "no version".
      env: withCliRuntimeOnPath(program, env),
      timeoutMs: PROBE_TIMEOUT_MS
    })
    return result.code === 0 && !result.timedOut ? parseVersion(result.stdout) : null
  } catch {
    return null
  }
}

async function runNpmPrefixProbe(env: NodeJS.ProcessEnv): Promise<string | null> {
  const npm = resolveCliCommand('npm', { pathEnv: env.PATH ?? env.Path ?? null })
  if (!isAbsolute(npm)) {
    return null
  }
  try {
    const result = await runProcess({
      program: npm,
      args: ['prefix', '-g'],
      env: withCliRuntimeOnPath(npm, env),
      timeoutMs: PROBE_TIMEOUT_MS
    })
    const prefix = result.stdout.trim().split(/\r?\n/).pop()?.trim() ?? ''
    return result.code === 0 && !result.timedOut && prefix.length > 0 ? prefix : null
  } catch {
    return null
  }
}

function realpathOrNull(path: string): string | null {
  try {
    return statSync(path).isFile() ? realpathSync(path) : null
  } catch {
    return null
  }
}

export async function describeCodexInstallation(
  deps: CodexInstallationDiagnosticsDeps = {}
): Promise<CodexInstallationDiagnostics> {
  const env = await (deps.resolveEnvironment ?? resolveLoginShellEnvironment)()
  const platform = deps.platform ?? process.platform
  const realpath = deps.realpath ?? realpathOrNull
  const command = resolveCliCommand('codex', {
    pathEnv: env.PATH ?? env.Path ?? null,
    platform,
    ...((env.HOME ?? env.USERPROFILE) ? { homePath: env.HOME ?? env.USERPROFILE } : {})
  })
  const realPath = isAbsolute(command) ? realpath(command) : null
  const [version, npmGlobalPrefix] = await Promise.all([
    isAbsolute(command) ? (deps.runVersion ?? runVersionProbe)(command, env) : null,
    (deps.runNpmPrefix ?? runNpmPrefixProbe)(env)
  ])
  const npmGlobalCodexCandidate = npmGlobalPrefix
    ? platform === 'win32'
      ? join(npmGlobalPrefix, 'codex.cmd')
      : join(npmGlobalPrefix, 'bin', 'codex')
    : null
  const npmGlobalCodexReal = npmGlobalCodexCandidate ? realpath(npmGlobalCodexCandidate) : null
  const npmGlobalCodexPath = npmGlobalCodexReal ? npmGlobalCodexCandidate : null
  const npmGlobalCodexVersion =
    npmGlobalCodexPath && npmGlobalCodexReal !== realPath
      ? await (deps.runVersion ?? runVersionProbe)(npmGlobalCodexPath, env)
      : npmGlobalCodexPath
        ? version
        : null
  return {
    command,
    realPath,
    version,
    npmGlobalPrefix,
    npmGlobalCodexPath,
    npmGlobalCodexVersion,
    // Why: only a launch that resolves somewhere else than the npm copy is a
    // divergence; a missing npm copy means the updater would create a second install.
    updateTargetDiverges:
      realPath !== null && npmGlobalPrefix !== null && npmGlobalCodexReal !== realPath,
    checkedAt: (deps.now ?? Date.now)()
  }
}

let cached: { value: Promise<CodexInstallationDiagnostics>; at: number } | null = null

/** Cached for a minute: the answer only changes when someone installs Codex. */
export function describeCodexInstallationCached(
  options: { force?: boolean } = {}
): Promise<CodexInstallationDiagnostics> {
  const now = Date.now()
  if (!options.force && cached && now - cached.at < CACHE_TTL_MS) {
    return cached.value
  }
  const value = describeCodexInstallation().catch((error: unknown) => {
    cached = null
    throw error
  })
  cached = { value, at: now }
  return value
}

export function resetCodexInstallationDiagnosticsCacheForTests(): void {
  cached = null
}
