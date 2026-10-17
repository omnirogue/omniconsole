import type { HookCommandConfig, HooksConfig } from '../agent-hooks/installer-utils'
import { CLAUDE_EVENTS, hasSameManagedHookInvocation } from './hook-settings'

/** Which lifecycle events carry the managed hook, so a partial install is never reported as whole. */
export function countManagedHookEvents(
  config: HooksConfig,
  expectedHook: HookCommandConfig
): { presentCount: number; missing: string[] } {
  const missing: string[] = []
  let presentCount = 0
  for (const event of CLAUDE_EVENTS) {
    const definitions = Array.isArray(config.hooks?.[event.eventName])
      ? config.hooks![event.eventName]!
      : []
    const hasCommand = definitions.some((definition) =>
      (definition.hooks ?? []).some((hook) => hasSameManagedHookInvocation(hook, expectedHook))
    )
    if (hasCommand) {
      presentCount += 1
    } else {
      missing.push(event.eventName)
    }
  }
  return { presentCount, missing }
}
