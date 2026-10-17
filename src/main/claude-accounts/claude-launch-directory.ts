import { carryClaudeProjectTrust } from '../agent-trust-presets'
import { ensureClaudeHooksForRequestedEnv } from './account-directory-hooks'
import { keepClaudeDiffPanelClosed } from './claude-diff-panel-preference'
import type { ClaudeRuntimeAuthPreparation } from './runtime-auth/runtime-auth-types'
import { applyClaudeSetupTokenDirectory } from './setup-token-directory'

/**
 * What a local spawn needs in the Claude config directory once account preparation chose it: the
 * setup token the launch named, the managed hooks, the folder trust the launch recorded before
 * the account was known, and Claude's diff pane kept shut until asked for. Shared by the runtime
 * and renderer spawn paths.
 */
export function prepareClaudeLaunchDirectory(
  env: Record<string, string>,
  requestedEnv: Record<string, string> | undefined,
  launch: { cwd: string | undefined; claudeAuth: ClaudeRuntimeAuthPreparation | null }
): void {
  applyClaudeSetupTokenDirectory(env, requestedEnv)
  ensureClaudeHooksForRequestedEnv(requestedEnv)
  // Why not WSL: its directory lives inside the distro, where the host cannot read the trust.
  if (launch.claudeAuth && launch.claudeAuth.runtime !== 'wsl') {
    try {
      carryClaudeProjectTrust(
        launch.cwd,
        launch.claudeAuth.configDir,
        requestedEnv?.CLAUDE_CONFIG_DIR
      )
    } catch {
      // Best effort: the person can still answer Claude's trust question in the terminal.
    }
    try {
      // Why merged: the child inherits this process's env under the launch's own values.
      keepClaudeDiffPanelClosed(launch.claudeAuth.configDir, { ...process.env, ...env })
    } catch {
      // Best effort: Claude's own diff pane still closes with /diff.
    }
  }
}
