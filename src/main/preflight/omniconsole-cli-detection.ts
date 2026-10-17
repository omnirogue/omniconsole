import {
  isOmniConsoleCliCommandName,
  OMNICONSOLE_CLI_COMMAND_NAMES
} from '../../shared/omniconsole-cli-launcher'

export type OmniConsoleCliDetectionDeps = {
  platform: NodeJS.Platform
  /** The bundled or dev launcher on this host's disk, or null. */
  launcher: string | null
  /** The absolute executable a bare command resolves to on PATH, or null. */
  resolveCommandPath: (command: string) => Promise<string | null>
  realpath: (candidate: string) => Promise<string>
}

/**
 * Whether a resolved executable is an OmniConsole launcher rather than a namesake.
 * Packaged mac: a launcher inside the app bundle (`<App>.app/Contents/…`; the optional
 * `/usr/local/bin/omni` registration symlinks there). Dev: `<userData>/cli/bin/omni-dev`.
 * A pip/pyenv script such as `~/.pyenv/versions/3.12.1/bin/omni` matches neither.
 */
export function isOmniConsoleCliLauncherPath(resolvedPath: string): boolean {
  const normalized = resolvedPath.replace(/\\/g, '/')
  const name = normalized.split('/').pop() ?? ''
  if (!isOmniConsoleCliCommandName(name)) {
    return false
  }
  if (/\.app\/Contents\//.test(normalized)) {
    return true
  }
  return name === 'omni-dev' && normalized.endsWith('/cli/bin/omni-dev')
}

/**
 * Reconcile the OmniConsole CLI's presence for Agent Teams detection.
 *
 * Why: detection used to count any `omni` on PATH, so a Mac carrying another `omni`
 * (a Python CLI behind a pyenv shim) advertised Agent Teams that could never start.
 * A bundled launcher on disk counts as present whether or not PATH knows it, because
 * local launches run it by absolute path; without a bundle, a PATH `omni` counts only
 * when it really is an OmniConsole launcher. Other platforms keep PATH detection.
 */
export async function reconcileOmniConsoleCliDetection(
  found: ReadonlySet<string>,
  deps: OmniConsoleCliDetectionDeps
): Promise<Set<string>> {
  const next = new Set(found)
  if (deps.launcher) {
    next.add('omni')
    return next
  }
  if (deps.platform !== 'darwin') {
    return next
  }
  for (const name of OMNICONSOLE_CLI_COMMAND_NAMES) {
    if (!next.has(name)) {
      continue
    }
    let resolved: string | null = null
    try {
      const candidate = await deps.resolveCommandPath(name)
      // Why: realpath follows the /usr/local/bin registration symlink into the bundle;
      // when it cannot, the PATH entry itself is the only identity there is.
      resolved = candidate ? await deps.realpath(candidate).catch(() => candidate) : null
    } catch {
      resolved = null
    }
    if (!resolved || !isOmniConsoleCliLauncherPath(resolved)) {
      next.delete(name)
    }
  }
  return next
}
