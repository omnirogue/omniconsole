import {
  isWslShellName,
  resolveLocalWindowsTerminalRuntimeOptions
} from '../../shared/local-windows-terminal-runtime'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import { isWslUncPath } from '../../shared/wsl-paths'

/**
 * Whether a local agent spawn of this workspace runs in WSL, decided the way spawn preflight
 * decides it. Spawn then prepares the WSL-selected login and drops a host account pin.
 */
export function agentLaunchRunsInWsl(args: {
  path: string
  connectionId: string | null
  platform: NodeJS.Platform
  projectRuntime: ProjectExecutionRuntimeResolution | undefined
  terminalWindowsShell: string | undefined
}): boolean {
  if (args.connectionId) {
    return false
  }
  if (isWslUncPath(args.path)) {
    return true
  }
  if (args.platform !== 'win32') {
    return false
  }
  if (args.projectRuntime?.status === 'repair-required') {
    // Why: only a WSL project runtime needs repair (spawn refuses it until then).
    return true
  }
  const { shellOverride } = resolveLocalWindowsTerminalRuntimeOptions({
    requestedShellOverride: undefined,
    settings: { terminalWindowsShell: args.terminalWindowsShell },
    projectRuntime: args.projectRuntime
  })
  return isWslShellName(shellOverride)
}
