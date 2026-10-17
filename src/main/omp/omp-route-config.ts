import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { assertOpenRouterRoute } from '../../shared/openrouter-route'
import type { AgentLaunchPreferences } from '../../shared/agent-session-host-authority'
import { getOmpApprovalOverlayConfigPath } from '../../shared/omp-approval-overlay'
import {
  tokenizeStartupCommand,
  quoteStartupArg,
  type AgentStartupShell
} from '../../shared/tui-agent-startup-shell'

export function ompRouteConfig(preferences: AgentLaunchPreferences, approval = false): string {
  assertOpenRouterRoute({ agent: 'omp', ...preferences })
  const candidates = preferences.openrouterCandidates ?? []
  return JSON.stringify({
    ...(approval ? { tools: { approvalMode: 'write' } } : {}),
    retry: {
      modelFallback: candidates.length > 1,
      usageAwareFallback: false,
      fallbackChains:
        candidates.length > 1
          ? {
              [preferences.model!]: candidates.slice(1).map((id) => `openrouter/${id}`)
            }
          : {},
      fallbackRevertPolicy: 'never'
    }
  })
}

/** Immutable, content-addressed config holds routing only; credentials remain in the existing home. */
export function writeOmpRouteConfig(preferences: AgentLaunchPreferences, approval = false): string {
  const contents = ompRouteConfig(preferences, approval)
  const directory = join(homedir(), '.omniconsole', 'omp-routes')
  mkdirSync(directory, { recursive: true })
  const path = join(directory, `${createHash('sha256').update(contents).digest('hex')}.json`)
  try {
    writeFileSync(path, contents, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
      readFileSync(path, 'utf8') !== contents
    ) {
      throw error
    }
  }
  return path
}

export function ompRouteLaunchArgs(input: {
  agent: string
  preferences?: AgentLaunchPreferences
  agentArgs?: string | null
  shell?: AgentStartupShell
  isRemote?: boolean
  approval?: boolean
}): string | null | undefined {
  assertOpenRouterRoute({ agent: input.agent, ...input.preferences })
  if (input.agent !== 'omp' || !input.preferences?.model) {
    return input.agentArgs
  }
  if (input.isRemote) {
    throw new Error(
      'omp_route_capability_unavailable: SSH routes require host-owned route preparation.'
    )
  }
  const shell = input.shell ?? 'posix'
  const parsed = tokenizeStartupCommand(input.agentArgs ?? '', shell)
  if (!parsed.ok) {
    throw new Error(parsed.error)
  }
  const tokens = [...parsed.tokens]
  let approval = input.approval ?? false
  const config = tokens.findIndex((token) => token === '--config' || token.startsWith('--config='))
  if (config !== -1) {
    const path = tokens[config + 1]
    approval =
      path === getOmpApprovalOverlayConfigPath() ||
      path === writeOmpRouteConfig(input.preferences, true)
    if (
      tokens[config] !== '--config' ||
      (!approval && path !== writeOmpRouteConfig(input.preferences))
    ) {
      throw new Error('An explicit OMP config cannot override the saved model route.')
    }
    tokens.splice(config, 2)
  }
  if (tokens.some((token) => token === '--config' || token.startsWith('--config='))) {
    throw new Error('Multiple OMP configs cannot override the saved route.')
  }
  tokens.push('--config', writeOmpRouteConfig(input.preferences, approval))
  return tokens.map((token) => quoteStartupArg(token, shell)).join(' ')
}
