/**
 * The work-delivery claimer's login check before it reopens or types into a session. It holds
 * only on proof the account cannot run a turn here: signed out, or at its usage limit. An account
 * no login row names, or a reading too old to decide, is not proof (a held answer waits at least a
 * minute); a turn a login failure then cuts off is continued once the login is back.
 */

import { parseSessionReference } from '../../shared/session-reference'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import type { WorkDeliveryTarget } from '../work-delivery/work-delivery-kind'
import { findLoginRow, loginReadinessOf } from './account-login-ready'

type GateRuntime = Pick<OrcaRuntimeService, 'getAccountsSnapshot' | 'getAgentAccountSettings'>

export type LoginGateVerdict = { ready: true } | { ready: false; reason: string }

/** `WorkDeliveryDeps.loginReady`: `target.accountId` is the account home the conversation ran under. */
export function answerLoginGate(
  runtime: GateRuntime,
  now: () => number = Date.now
): (target: WorkDeliveryTarget) => Promise<LoginGateVerdict> {
  return async (target) => {
    const provider = parseSessionReference(target.ref)?.agent
    if ((provider !== 'claude' && provider !== 'codex') || !target.accountId) {
      return { ready: true }
    }
    let row: ReturnType<typeof findLoginRow>
    try {
      const capacity = runtime.getAccountsSnapshot().rateLimits.accountCapacity
      row = findLoginRow(
        { claude: capacity?.claude ?? [], codex: capacity?.codex ?? [] },
        runtime.getAgentAccountSettings(),
        { provider, home: target.accountId }
      )
    } catch {
      return { ready: true }
    }
    if (!row) {
      return { ready: true }
    }
    const verdict = loginReadinessOf(row, { now: now() })
    if (verdict.ready || verdict.refresh) {
      return { ready: true }
    }
    return { ready: false, reason: `${capitalize(verdict.reason)}; it is sent once that changes.` }
  }
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)
