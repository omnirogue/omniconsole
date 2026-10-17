import { z } from 'zod'
import { getAgentSessionOptionCatalog, findCatalogModel } from './agent-session-option-catalog'
import { resolveAgentAccountLaunchEnv } from './agent-account-profiles'
export type AutomationLaunchPreferences = {
  permissionMode?: 'yolo' | 'read-only'
  model?: string
  effort?: string
  codexAccountId?: string
}
import type { AgentAccountSettings } from './agent-account-profiles'
import type { TuiAgent } from './tui-agent'

export const automationLaunchPreferencesSchema = z
  .object({
    permissionMode: z.enum(['yolo', 'read-only']).optional(),
    model: z.string().trim().min(1).max(120).optional(),
    effort: z.string().trim().min(1).max(120).optional(),
    codexAccountId: z.string().trim().min(1).max(120).optional()
  })
  .strict()

export function automationEffortOptions(agent: TuiAgent, model?: string) {
  const catalog = getAgentSessionOptionCatalog(agent)
  const options = model && catalog ? findCatalogModel(catalog, model)?.options : undefined
  const effort = (options ?? catalog?.unknownModelOptions ?? []).find(
    (option) => option.id === 'effort'
  )
  return effort?.kind.type === 'select' ? effort.kind.choices : []
}

export function validAutomationLaunchPreferences(
  agent: TuiAgent,
  preferences?: AutomationLaunchPreferences | null
): boolean {
  if (!preferences) {
    return true
  }
  if (preferences.codexAccountId && agent !== 'codex') {
    return false
  }
  return (
    !preferences.effort ||
    !['codex', 'claude'].includes(agent) ||
    automationEffortOptions(agent, preferences.model).some(
      (choice) => choice.value === preferences.effort
    )
  )
}

export function normalizeAutomationLaunchPreferences(
  agent: TuiAgent,
  value: unknown
): AutomationLaunchPreferences | undefined {
  const parsed = automationLaunchPreferencesSchema.safeParse(value)
  return parsed.success &&
    validAutomationLaunchPreferences(agent, parsed.data) &&
    Object.keys(parsed.data).length
    ? parsed.data
    : undefined
}

export function automationLaunchAccountEnv(
  settings: AgentAccountSettings | null | undefined,
  agent: TuiAgent,
  preferences?: AutomationLaunchPreferences,
  isSsh = false
): Record<string, string> | undefined {
  if (!preferences?.codexAccountId) {
    return undefined
  }
  // Why: a client-managed home cannot identify an account on a separate SSH host.
  if (isSsh) {
    throw new Error('Pinned Codex accounts require an automation on the account-owning runtime.')
  }
  const env = resolveAgentAccountLaunchEnv(settings, agent, `managed:${preferences.codexAccountId}`)
  if (!env) {
    throw new Error('The pinned Codex account is no longer available on this host.')
  }
  return env
}

export function assertAutomationLaunchPreferences(
  agent: TuiAgent,
  preferences?: AutomationLaunchPreferences | null
): void {
  if (preferences == null) {
    return
  }
  const parsed = automationLaunchPreferencesSchema.parse(preferences)
  if (!validAutomationLaunchPreferences(agent, parsed)) {
    throw new Error('Invalid launch preferences for agent')
  }
}
