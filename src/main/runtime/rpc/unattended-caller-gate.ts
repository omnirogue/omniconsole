/**
 * The bound on an unattended caller (an automatic cleanup session) at the socket: it may read
 * sessions, run `omni session tidy`, and ask or nudge under the steward's limits. Everything else
 * (typing into or renaming terminals, launching sessions, automations, orchestration, folder and
 * organize changes) is refused before any handler runs, so a new method is closed by default.
 */

import { SESSION_FOLDERS_RPC } from '../../../shared/session-folder-cli'
import {
  SESSION_MANAGE_RPC,
  type SessionManageUnattended
} from '../../../shared/session-manage-types'
import { SESSION_ORGANIZATION_RPC } from '../../../shared/session-organization-change'
import { SESSION_ORGANIZATION_ACTIONS_RPC } from '../../../shared/session-organization-readers'
import type { OrchestrationCompatibilityEvidence } from '../../../shared/orchestration-compatibility-evidence'
import { unattendedPaneContext } from '../../session-manage/session-manage-unattended'
import type { RpcRequest } from './core'

/** Each gated one applies the unattended policy itself (`assertUnattendedPolicy`, Tier 2 tidy). */
export const UNATTENDED_CALLER_METHODS: ReadonlySet<string> = new Set([
  'status.get',
  'sessionSearch.query',
  SESSION_MANAGE_RPC.list,
  SESSION_MANAGE_RPC.conflicts,
  SESSION_MANAGE_RPC.findOwner,
  SESSION_MANAGE_RPC.tidy,
  SESSION_MANAGE_RPC.ask,
  SESSION_MANAGE_RPC.continue,
  SESSION_FOLDERS_RPC.list,
  SESSION_ORGANIZATION_RPC.history,
  SESSION_ORGANIZATION_RPC.recent,
  SESSION_ORGANIZATION_ACTIONS_RPC
])

export function unattendedCallerRefusal(method: string): string {
  return `An automatic cleanup session runs with no person present, so it cannot call ${method}. It may read sessions, run omni session tidy, and ask or nudge sessions within the steward's limits. Nothing changed.`
}

export type UnattendedCallerBinding = (input: {
  callerPid?: number
  evidence?: OrchestrationCompatibilityEvidence
}) => Promise<SessionManageUnattended | null>

let binding: UnattendedCallerBinding | null = null

/** Installed by the cleanup runs (process-tree binding); returns the restore. */
export function setUnattendedCallerBinding(next: UnattendedCallerBinding | null): () => void {
  const previous = binding
  binding = next
  return () => {
    binding = previous
  }
}

export function callerPid(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 1 ? value : undefined
}

/**
 * A Unix-socket caller's unattended context: its claimed pane is a registered cleanup pane, or its
 * process tree is an automatic run's. Only the socket admission asks: the window, paired devices
 * and in-process relays never run inside a cleanup session's process tree.
 */
export async function unattendedSocketCaller(
  request: Pick<RpcRequest, 'callerPid' | 'orchestrationCompatibilityEvidence'>
): Promise<SessionManageUnattended | null> {
  const evidence = request.orchestrationCompatibilityEvidence
  // Why an unproven claim counts: it can only make the caller more restricted.
  const claimed = unattendedPaneContext(evidence?.paneKey)
  if (claimed || !binding) {
    return claimed
  }
  try {
    return await binding({ callerPid: callerPid(request.callerPid), evidence })
  } catch {
    // Why fail closed: a binding that cannot answer must not turn a cleanup run into a person.
    return { source: 'cleanup-run' }
  }
}
