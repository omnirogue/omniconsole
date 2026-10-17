import { getAppEnvironment, hasAppEnvironment } from '../shared/app-environment'
import { setLocalOmniConsoleCliLauncher } from '../shared/omniconsole-cli-launcher'
import { resolveLocalOrchestrationCliLauncher } from './runtime/orchestration/cli-command'

/**
 * The OmniConsole CLI launcher on this host's disk — the packaged
 * `Resources/bin/omni` or the dev `<userData>/cli/bin/omni-dev` — or null when
 * none is bundled here (a Linux package, a host without an app environment yet).
 */
export function resolveLocalOmniConsoleCliLauncher(): string | null {
  if (!hasAppEnvironment()) {
    return null
  }
  try {
    const environment = getAppEnvironment()
    return resolveLocalOrchestrationCliLauncher({
      isPackaged: environment.isPackaged(),
      userDataPath: environment.getPath('userData'),
      resourcesPath: (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
      platform: process.platform
    })
  } catch {
    return null
  }
}

/**
 * Register the lazy resolver every launch-command build in this process consults.
 * Called once per host entrypoint right after the app environment is installed.
 */
export function installLocalOmniConsoleCliLauncher(): void {
  setLocalOmniConsoleCliLauncher(resolveLocalOmniConsoleCliLauncher)
}
