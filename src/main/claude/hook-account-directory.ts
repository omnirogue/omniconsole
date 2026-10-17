import { join } from 'node:path'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { writeHooksJson, writeManagedScript } from '../agent-hooks/installer-utils'
import { readHooksJson } from '../agent-hooks/hooks-json-read'
import {
  DEFAULT_CLAUDE_HOOK_SERVICE_OPTIONS,
  getManagedScript,
  type ClaudeHookServiceOptions
} from './hook-service'
import { countManagedHookEvents } from './hook-managed-presence'
import {
  applyManagedHooks,
  getManagedLifecycleHook,
  getManagedScriptFileName,
  getManagedScriptPath
} from './hook-settings'

/**
 * Install the managed lifecycle hooks into an account profile's config directory (a
 * launch that sets CLAUDE_CONFIG_DIR). Why: such a profile reads its own settings.json,
 * so the hooks in the default directory never reach it and no status ever arrives — the
 * host then reads every prompt as stalled and every step as never working. Reuses the
 * default profile's managed script; no statusline (the usage feed is per host).
 */
export function installManagedHooksIntoConfigDir(
  configDir: string,
  options: ClaudeHookServiceOptions = DEFAULT_CLAUDE_HOOK_SERVICE_OPTIONS
): AgentHookInstallStatus {
  const configPath = join(configDir, 'settings.json')
  const scriptPath = getManagedScriptPath(options.settings)
  const config = readHooksJson(configPath)
  if (!config) {
    return {
      agent: options.agent,
      state: 'error',
      configPath,
      managedHooksPresent: false,
      detail: `Could not parse ${options.displayName} settings.json`
    }
  }
  const hook = getManagedLifecycleHook(scriptPath, options.settings)
  if (countManagedHookEvents(config, hook).missing.length > 0) {
    writeManagedScript(
      scriptPath,
      getManagedScript('local', { skipWhenDevinImportsClaude: options.agent === 'claude' })
    )
    writeHooksJson(
      configPath,
      applyManagedHooks(config, hook, getManagedScriptFileName(options.settings))
    )
  }
  return {
    agent: options.agent,
    state: 'installed',
    configPath,
    managedHooksPresent: true,
    detail: null
  }
}
