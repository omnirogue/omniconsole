import { installManagedHooksIntoConfigDir } from '../claude/hook-account-directory'
import { claudeHookService } from '../claude/hook-service'

export type AccountDirectoryHookDeps = {
  /** Whether the default profile carries the managed hooks — the person's choice to mirror. */
  defaultProfileHasHooks: () => boolean
  install: (configDir: string) => { state: string; detail: string | null }
}

const defaultDeps: AccountDirectoryHookDeps = {
  defaultProfileHasHooks: () => claudeHookService.getStatus().managedHooksPresent,
  install: (configDir) => installManagedHooksIntoConfigDir(configDir)
}

/** Directories already ensured by this process; a spawn must not rewrite settings.json every time. */
const ensuredDirectories = new Set<string>()

/**
 * Why: a launch that names a Claude config directory (an account profile or managed
 * account) runs an agent whose hooks live in THAT directory. Mirror the managed lifecycle
 * hooks there, once per process, when the person keeps them in the default profile —
 * otherwise no status reaches the host and every prompt reads as stalled.
 */
export function ensureClaudeHooksForRequestedEnv(
  requestedEnv: Record<string, string> | undefined,
  deps: AccountDirectoryHookDeps = defaultDeps
): void {
  const configDir = requestedEnv?.CLAUDE_CONFIG_DIR?.trim()
  if (!configDir || ensuredDirectories.has(configDir)) {
    return
  }
  ensuredDirectories.add(configDir)
  try {
    if (!deps.defaultProfileHasHooks()) {
      return
    }
    const status = deps.install(configDir)
    if (status.state === 'error') {
      console.warn('[claude-accounts] managed hooks not installed for', configDir, status.detail)
    }
  } catch (error) {
    console.warn('[claude-accounts] managed hooks not installed for', configDir, error)
  }
}

/** Test seam. */
export function resetEnsuredClaudeHookDirectoriesForTests(): void {
  ensuredDirectories.clear()
}
