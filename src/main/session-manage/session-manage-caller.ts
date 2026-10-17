/**
 * Who may manage sessions, and who is acting.
 *
 * Who (Sal, 2026-09-24, D1): any conversation on this computer, when the person asks it. So the
 * gate is the local socket only, exactly like `omni folder`: a paired phone or another computer
 * carries a client identity and is refused, and so is a dispatched worker's capability.
 *
 * Who is acting: the pane's launch evidence the CLI attaches (ORCA_TERMINAL_HANDLE, ORCA_PANE_KEY,
 * ORCA_AGENT_LAUNCH_TOKEN), verified by the same host check `omni outcome commit` uses. A claim
 * the host cannot verify is recorded as the plain CLI, never as the pane it names. No caller can
 * be the `steward` actor: only the steward's own main-process code builds it.
 */

import type { OrchestrationCompatibilityEvidence } from '../../shared/orchestration-compatibility-evidence'
import type { SessionManageActor } from '../../shared/session-manage-types'
import type { RpcContext } from '../runtime/rpc/core'

export const SESSION_MANAGE_LOCAL_ONLY_ERROR =
  'Only the omni CLI on this computer can manage its sessions; a paired device or another computer cannot.'
export const SESSION_MANAGE_CAPABILITY_ERROR =
  'A dispatched worker cannot manage sessions with its dispatch capability. Ask the person, or run the command without it.'

export function assertSessionManageCaller(context: RpcContext): void {
  if (context.pairedDeviceId || context.clientId || context.clientKind) {
    throw new Error(SESSION_MANAGE_LOCAL_ONLY_ERROR)
  }
  if (context.orchestrationCapability) {
    throw new Error(SESSION_MANAGE_CAPABILITY_ERROR)
  }
}

/** The pane a caller's evidence proves, or null; never throws. */
export type SessionManagePaneVerifier = (
  evidence: OrchestrationCompatibilityEvidence
) => string | null

export function resolveSessionManageActor(
  evidence: OrchestrationCompatibilityEvidence | undefined,
  verify: SessionManagePaneVerifier,
  titleOf: (paneKey: string) => string | null
): SessionManageActor {
  if (!evidence) {
    return { kind: 'cli' }
  }
  let proven: string | null = null
  try {
    proven = verify(evidence)
  } catch {
    proven = null
  }
  if (proven) {
    return { kind: 'pane', paneKey: proven, title: titleOf(proven) ?? 'another session' }
  }
  const claimed = evidence.paneKey?.trim()
  return claimed ? { kind: 'cli', unverifiedPaneKey: claimed } : { kind: 'cli' }
}

/** The acting pane's key as a queue entry and decision log record it (`steward` for the app). */
export function sessionManageActorId(actor: SessionManageActor): string {
  return actor.kind === 'pane' ? actor.paneKey : actor.kind
}

export function isSelfTarget(actor: SessionManageActor, paneKey: string | null): boolean {
  return actor.kind === 'pane' && paneKey !== null && actor.paneKey === paneKey
}
