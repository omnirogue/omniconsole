/**
 * What every owner action checks before anything moves: the conversation still has a pane here,
 * who is acting, and whether an automatic caller may act on it now. Session-manage refusals come
 * back as host refusals with the most specific code the check that refused establishes.
 */

import { sessionHostRefusal, type SessionHostRefusal } from '../../shared/session-host-refusal'
import type { SessionHostAuthority } from '../../shared/session-host-authority'
import type { SessionManageActor } from '../../shared/session-manage-types'
import type { SessionHostRegistration } from '../session-host/session-host-journal'
import { SessionManageRefusal } from '../session-manage/session-manage-refusal'
import {
  assertUnattendedPolicy,
  stewardSwitchRefusal,
  SWITCH_OF,
  unattendedContextFor,
  type UnattendedAction
} from '../session-manage/session-manage-unattended'
import type { HostSession, HostSessionInventory } from './host-session-inventory'
import { sessionHostActor } from './session-host-actor'
import { hostAutomationRefusal } from './session-host-switches'

export type OwnerTarget = {
  session: HostSession
  actor: SessionManageActor
  /** Null when a person (or an agent at the person's request) is behind it. */
  unattended: boolean
}

const HARD_STOP_PREFIX = 'Refused (hard stop'

export function refusalOf(error: unknown, code: SessionHostRefusal['code'] = 'not-eligible') {
  const message = error instanceof Error ? error.message : String(error)
  return sessionHostRefusal(message.startsWith(HARD_STOP_PREFIX) ? 'hard-stop' : code, message)
}

/** Runs a check that throws a session-manage refusal; anything else is not a refusal. */
export function checked(
  check: () => void,
  code: SessionHostRefusal['code']
): SessionHostRefusal | null {
  try {
    check()
    return null
  } catch (error) {
    if (error instanceof SessionManageRefusal) {
      return refusalOf(error, code)
    }
    throw error
  }
}

export async function resolveOwnerTarget(input: {
  inventory: HostSessionInventory
  registration: SessionHostRegistration | null
  authority: SessionHostAuthority
}): Promise<OwnerTarget | SessionHostRefusal> {
  const { registration } = input
  if (!registration?.binding) {
    return sessionHostRefusal(
      'not-eligible',
      'That computer holds no pane for this conversation now, so nothing was done.'
    )
  }
  const session = await input.inventory.find(registration.binding, registration.provider)
  if (!session) {
    return sessionHostRefusal(
      'not-eligible',
      'That computer lists no session for this conversation now, so nothing was done.'
    )
  }
  const actor = sessionHostActor(input.authority)
  const unattended = unattendedContextFor(actor) !== null
  if (unattended) {
    const off = hostAutomationRefusal(session.row.folderId)
    if (off) {
      return sessionHostRefusal('automation-disabled', off)
    }
  }
  return { session, actor, unattended }
}

/**
 * The unattended rules, classified: a switch that is off is `automation-disabled`, a driver it
 * would take over is `has-driver`, anything else the steward may not do is `unattended-restricted`.
 */
export function unattendedRefusal(
  target: OwnerTarget,
  action: UnattendedAction
): SessionHostRefusal | null {
  if (!target.unattended) {
    return null
  }
  const feature = action in SWITCH_OF ? SWITCH_OF[action as keyof typeof SWITCH_OF] : null
  const off = feature ? stewardSwitchRefusal(feature) : null
  if (off) {
    return sessionHostRefusal('automation-disabled', off)
  }
  const refusal = checked(
    () => assertUnattendedPolicy(target.actor, action),
    'unattended-restricted'
  )
  if (refusal) {
    return refusal
  }
  return target.session.entry.keepGoing &&
    (action === 'yes' || action === 'prompt' || action === 'ask')
    ? sessionHostRefusal(
        'has-driver',
        `“${target.session.entry.title}” is driven by Keep going; an automatic caller never prompts it or turns its Keep going off. Nothing was sent.`
      )
    : null
}
