import type { Automation } from '../../../../../shared/automations-types'
import {
  getAutomationHostTargetKey,
  type AutomationHostTarget
} from '@/components/automations/automation-host-client'

const ROUTINE_VIEW_KEY_PREFIX = 'routine:'

/** The per-device identity of a routine row: `routine:<catalog authority>:<automation id>`. */
export function routineViewKey(
  target: AutomationHostTarget,
  automation: Pick<Automation, 'id'>
): string {
  return `${ROUTINE_VIEW_KEY_PREFIX}${getAutomationHostTargetKey(target)}:${automation.id}`
}

export function isRoutineViewKey(key: string): boolean {
  return key.startsWith(ROUTINE_VIEW_KEY_PREFIX)
}

/** Inverse of `routineViewKey`; null for anything that is not a routine key. */
export function parseRoutineViewKey(
  key: string
): { hostKey: string; automationId: string } | null {
  if (!isRoutineViewKey(key)) {
    return null
  }
  const rest = key.slice(ROUTINE_VIEW_KEY_PREFIX.length)
  // Why: the authority key may itself hold colons (`environment:<id>`); automation ids never do.
  const split = rest.lastIndexOf(':')
  if (split <= 0 || split === rest.length - 1) {
    return null
  }
  return { hostKey: rest.slice(0, split), automationId: rest.slice(split + 1) }
}

/** The entry `view.hidden` holds for a routine hidden by hand, alongside group keys. */
export function routineHiddenKey(routineKey: string): string {
  return `routine:${routineKey}`
}
