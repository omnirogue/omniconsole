import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  buildManagedCommandHook,
  buildWindowsAgentHookPostCommand,
  createManagedCommandMatcher,
  getSharedManagedScriptPath,
  MANAGED_HOOK_TIMEOUT_MILLISECONDS,
  readHooksJson,
  removeManagedCommands,
  wrapPosixHookCommand,
  wrapWindowsHookCommand,
  writeHooksJson,
  writeManagedScript,
  type HookDefinition,
  type HooksConfig
} from '../agent-hooks/installer-utils'
import { refreshManagedScriptIfPresent } from '../agent-hooks/managed-hook-script-refresh'
import {
  readHooksJsonRemote,
  writeHooksJsonRemote,
  writeManagedScriptRemote
} from '../agent-hooks/installer-utils-remote'
import {
  buildPosixHookPayloadCapture,
  buildPosixHookSpoolLines,
  buildWindowsHookEnvironmentGuardLines,
  buildWindowsHookStdinDrainEpilogue
} from '../agent-hooks/hook-stdin-contract'

// Why PermissionRequest: Qwen asks ask_user_question there, before its dialog; PreToolUse fires only after the answer.
export const QWEN_CODE_EVENTS = [
  { eventName: 'SessionStart', matcher: false },
  { eventName: 'UserPromptSubmit', matcher: false },
  { eventName: 'Stop', matcher: false },
  { eventName: 'PreToolUse', matcher: true },
  { eventName: 'PostToolUse', matcher: true },
  { eventName: 'PostToolUseFailure', matcher: true },
  { eventName: 'PermissionRequest', matcher: true }
] as const

const DISPLAY_NAME = 'Qwen Code settings.json'

function getConfigPath(): string {
  return join(homedir(), '.qwen', 'settings.json')
}

function getManagedScriptFileName(): string {
  return process.platform === 'win32' ? 'qwen-code-hook.cmd' : 'qwen-code-hook.sh'
}

function getManagedScriptPath(): string {
  return getSharedManagedScriptPath(getManagedScriptFileName())
}

// Why `{}`: Qwen parses hook stdout as hook output; the neutral object decides nothing, so its own permission UI still shows.
function getManagedCommand(scriptPath: string): string {
  return process.platform === 'win32'
    ? wrapWindowsHookCommand(scriptPath, {}, { fallbackStdout: '{}', bypassExecutionPolicy: false })
    : wrapPosixHookCommand(scriptPath, {}, { fallbackStdout: '{}' })
}

function getManagedScript(target: 'local' | 'posix' = 'local'): string {
  if (target === 'local' && process.platform === 'win32') {
    return [
      '@echo off',
      'setlocal',
      'echo {}',
      'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
      ...buildWindowsHookEnvironmentGuardLines(),
      buildWindowsAgentHookPostCommand('qwen-code'),
      'exit /b 0',
      ...buildWindowsHookStdinDrainEpilogue(),
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    ...buildPosixHookPayloadCapture('empty-object'),
    'printf "{}\\n"',
    ...buildPosixHookSpoolLines('qwen-code'),
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  spool_hook_event',
    '  exit 0',
    'fi',
    // Why: pipe the payload to curl's stdin so large tool output stays off the command line.
    'printf \'%s\' "$payload" | curl -sS -X POST "http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/qwen-code" \\',
    '  --connect-timeout 0.5 --max-time 1.5 \\',
    '  -H "Content-Type: application/x-www-form-urlencoded" \\',
    '  -H "X-Orca-Agent-Hook-Token: ${ORCA_AGENT_HOOK_TOKEN}" \\',
    '  -H "X-Omni-Agent-Hook-Token: ${ORCA_AGENT_HOOK_TOKEN}" \\',
    '  --data-urlencode "paneKey=${ORCA_PANE_KEY}" \\',
    '  --data-urlencode "tabId=${ORCA_TAB_ID}" \\',
    '  --data-urlencode "launchToken=${ORCA_AGENT_LAUNCH_TOKEN}" \\',
    '  --data-urlencode "worktreeId=${ORCA_WORKTREE_ID}" \\',
    '  --data-urlencode "env=${ORCA_AGENT_HOOK_ENV}" \\',
    '  --data-urlencode "version=${ORCA_AGENT_HOOK_VERSION}" \\',
    '  --data-urlencode "agentPid=${orca_agent_pid}" \\',
    '  --data-urlencode "agentPidHost=${orca_agent_pid_host}" \\',
    '  --data-urlencode "payload@-" >/dev/null 2>&1 || spool_hook_event',
    'exit 0',
    ''
  ].join('\n')
}

function withoutManagedHooks(
  hooks: NonNullable<HooksConfig['hooks']>,
  isManagedCommand: (command: string | undefined) => boolean
): NonNullable<HooksConfig['hooks']> {
  const next = { ...hooks }
  for (const [eventName, definitions] of Object.entries(next)) {
    // Why: leave malformed user entries untouched so a broken config never blocks install/remove.
    if (!Array.isArray(definitions)) {
      continue
    }
    const cleaned = removeManagedCommands(definitions, isManagedCommand)
    // Why: drop only a bucket this removal emptied; a user's own `[]` stays as written.
    if (cleaned.length === 0 && definitions.length > 0) {
      delete next[eventName]
    } else {
      next[eventName] = cleaned
    }
  }
  return next
}

// Why shared: local and SSH installs must write the same hook tree or remote panes report a different status.
export function applyQwenCodeManagedHooks(
  config: HooksConfig,
  command: string,
  scriptFileName: string
): HooksConfig {
  const hooks = withoutManagedHooks(config.hooks ?? {}, createManagedCommandMatcher(scriptFileName))
  for (const event of QWEN_CODE_EVENTS) {
    const current = Array.isArray(hooks[event.eventName]) ? hooks[event.eventName]! : []
    const definition: HookDefinition = {
      ...(event.matcher ? { matcher: '*' } : {}),
      // Why: Qwen's hook `timeout` is in milliseconds (Gemini CLI lineage), unlike Claude's seconds.
      hooks: [buildManagedCommandHook(command, MANAGED_HOOK_TIMEOUT_MILLISECONDS)]
    }
    hooks[event.eventName] = [...current, definition]
  }
  return { ...config, hooks }
}

export function removeQwenCodeManagedHooks(
  config: HooksConfig,
  scriptFileName: string
): { config: HooksConfig; changed: boolean } {
  const before = config.hooks ?? {}
  const hooks = withoutManagedHooks(before, createManagedCommandMatcher(scriptFileName))
  const changed = JSON.stringify(hooks) !== JSON.stringify(before)
  return { config: changed ? { ...config, hooks } : config, changed }
}

function errorStatus(configPath: string, detail: string): AgentHookInstallStatus {
  return { agent: 'qwen-code', state: 'error', configPath, managedHooksPresent: false, detail }
}

export class QwenCodeHookService {
  async refreshManagedScripts(): Promise<void> {
    await refreshManagedScriptIfPresent(getManagedScriptPath(), getManagedScript())
  }

  getStatus(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return errorStatus(configPath, `Could not parse ${DISPLAY_NAME}`)
    }
    const command = getManagedCommand(getManagedScriptPath())
    const missing: string[] = []
    for (const event of QWEN_CODE_EVENTS) {
      const definitions = config.hooks?.[event.eventName]
      const present =
        Array.isArray(definitions) &&
        definitions.some((definition) =>
          (definition.hooks ?? []).some((hook) => hook.command === command)
        )
      if (!present) {
        missing.push(event.eventName)
      }
    }
    const presentCount = QWEN_CODE_EVENTS.length - missing.length
    let state: AgentHookInstallState = 'installed'
    let detail: string | null = null
    if (presentCount === 0) {
      state = 'not_installed'
    } else if (missing.length > 0) {
      state = 'partial'
      detail = `Managed hook missing for events: ${missing.join(', ')}`
    }
    return { agent: 'qwen-code', state, configPath, managedHooksPresent: presentCount > 0, detail }
  }

  install(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const scriptPath = getManagedScriptPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return errorStatus(configPath, `Could not parse ${DISPLAY_NAME}`)
    }
    const next = applyQwenCodeManagedHooks(
      config,
      getManagedCommand(scriptPath),
      getManagedScriptFileName()
    )
    // Why: script before settings so settings never point at a missing script.
    writeManagedScript(scriptPath, getManagedScript())
    writeHooksJson(configPath, next)
    return this.getStatus()
  }

  // Why: SSH remotes run Qwen on the remote host; POSIX-only because the local OS says nothing about the remote's.
  async installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> {
    const home = remoteHome.replace(/\/$/, '')
    const remoteConfigPath = `${home}/.qwen/settings.json`
    const remoteScriptPath = `${home}/.omni/agent-hooks/qwen-code-hook.sh`
    try {
      const config = await readHooksJsonRemote(sftp, remoteConfigPath)
      if (!config) {
        return errorStatus(remoteConfigPath, `Could not parse remote ${DISPLAY_NAME}`)
      }
      const next = applyQwenCodeManagedHooks(
        config,
        wrapPosixHookCommand(remoteScriptPath, {}, { fallbackStdout: '{}' }),
        'qwen-code-hook.sh'
      )
      await writeManagedScriptRemote(sftp, remoteScriptPath, getManagedScript('posix'))
      await writeHooksJsonRemote(sftp, remoteConfigPath, next)
      return {
        agent: 'qwen-code',
        state: 'installed',
        configPath: remoteConfigPath,
        managedHooksPresent: true,
        detail: null
      }
    } catch (err) {
      return errorStatus(remoteConfigPath, err instanceof Error ? err.message : String(err))
    }
  }

  remove(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return errorStatus(configPath, `Could not parse ${DISPLAY_NAME}`)
    }
    const { config: next, changed } = removeQwenCodeManagedHooks(config, getManagedScriptFileName())
    if (changed) {
      writeHooksJson(configPath, next)
    }
    return this.getStatus()
  }
}

export const qwenCodeHookService = new QwenCodeHookService()
