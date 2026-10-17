/**
 * How the rules loop acts: in-process, as `{ kind: 'steward', feature: 'rules' }`, through exactly
 * the functions a person's command uses. `continueSession`/`queueQuestion` keep every delivery
 * rule, the hard stops, the marker and S1's unattended policy and prompt limits;
 * `relayOrganizationChange` records the archive with executor `app/steward`, Tier 2 re-checked
 * just before it applies. A blank session's close is `omni session delete`'s own relay (the
 * sidebar's Delete: its tab closes, its agent stops, Recently closed keeps it), admitted by the
 * blank-session rule just before it goes. Each applied action gets its audit line.
 */

import { randomUUID } from 'node:crypto'
import type { ConversationSource } from '../../shared/conversation-source'
import type { SessionManageActor, SessionManageEntry } from '../../shared/session-manage-types'
import type { TerminalAgentProcessProof } from '../runtime/terminal-agent-process'
import { auditActor, type SessionActionsLog } from '../session-manage/session-actions-log'
import { queueQuestion } from '../session-manage/session-manage-ask'
import { continueSession } from '../session-manage/session-manage-continue'
import type { SessionDeliveryDeps } from '../session-manage/session-manage-deliver'
import { STEWARD_EMPTY_SESSION_CLOSE_REASON } from '../../shared/session-steward-empty-session'
import { admitUnattendedOrganization } from '../session-manage/session-manage-unattended-admission'
import type { OrganizationChangeLedger } from '../session-organization/organization-change-ledger'
import {
  relayOrganizationChange,
  relayOrganizationMutation,
  type OrganizationRelay
} from '../session-organization/organization-relayed-mutation'

export const STEWARD_RULES_ACTOR: SessionManageActor = { kind: 'steward', feature: 'rules' }
export const STEWARD_TIER2_REASON = 'finished, not verified'

export type StewardTarget = {
  entry: SessionManageEntry
  source: ConversationSource
  agentProcess: TerminalAgentProcessProof | null
}

/** Each resolves with the summary of what it did, or throws with nothing done. */
export type StewardActions = {
  yes: (target: StewardTarget) => Promise<string>
  nudge: (target: StewardTarget, text: string) => Promise<string>
  ask: (target: StewardTarget, question: string) => Promise<string>
  /** Tier 2's reason unless another rule names its own (an empty session). */
  archive: (
    target: { paneKey: string; tabId: string | null; title: string },
    reason?: string
  ) => Promise<string>
  /**
   * Deletes a blank session as the sidebar's Delete does. `unchanged` is read right before the
   * relay: a prompt or keystroke since the judgment stops the close. Its summary says the agent
   * stopped only when its provider or SSH host confirmed the process ended.
   */
  close: (
    target: { paneKey: string; tabId: string | null; title: string; worktreeId: string },
    options?: { exited?: boolean; unchanged?: () => boolean }
  ) => Promise<string>
}

/** Taken before a close, it waits for its process's confirmed end (`watchPaneProcessStop`). */
export type StewardStopWatch = (target: {
  paneKey: string
  worktreeId: string
}) => (timeoutMs: number) => Promise<'stopped' | 'unconfirmed' | 'no-process'>

/** How long a close waits for the confirmed end, after its tab reported closing. */
export const STEWARD_STOP_RECEIPT_MS = 10_000

function closeSummary(
  title: string,
  tabClose: 'closed' | 'declined' | 'unverified' | undefined,
  exited: boolean,
  stop: 'stopped' | 'unconfirmed' | 'no-process'
): string {
  const name = `“${title}”`
  if (tabClose === 'declined') {
    return `Removed ${name} from the list, but its tab did not close, so its agent is still running.`
  }
  const tab = tabClose === 'closed' ? 'its tab closed' : 'its tab has not reported closing yet'
  // Why by receipt: a tab close is not proof, since the kill is sent without waiting for it.
  const agent = exited
    ? 'its agent had already exited'
    : stop === 'stopped'
      ? 'its agent was stopped'
      : 'its agent was not confirmed stopped and may still be running'
  return `Closed ${name}: nobody had asked it anything; ${tab} and ${agent}. Reopen it from Recently closed.`
}

export function createStewardActions(deps: {
  delivery: () => SessionDeliveryDeps
  ledger: () => Pick<OrganizationChangeLedger, 'prepare' | 'settle'>
  relay: OrganizationRelay
  audit: () => Pick<SessionActionsLog, 'append'>
  /** Absent: no stop is ever reported as confirmed. */
  stopWatch?: StewardStopWatch
}): StewardActions {
  const actor = STEWARD_RULES_ACTOR
  const record = async (
    action: 'continue' | 'ask',
    target: StewardTarget,
    summary: string,
    reason: string
  ): Promise<string> => {
    const { entry } = target
    const warning = await deps.audit().append({
      ...auditActor(actor),
      action,
      target: { paneKey: entry.paneKey, tabId: entry.tabId, title: entry.title },
      before: { state: entry.state, keepGoing: entry.keepGoing },
      summary,
      reason
    })
    return warning ? `${summary} ${warning}` : summary
  }
  return {
    yes: async (target) => {
      const { result } = await continueSession(deps.delivery(), {
        actor,
        target,
        answer: { kind: 'yes' },
        dryRun: false
      })
      return record('continue', target, result.summary, 'A safe next step inside its request')
    },
    nudge: async (target, text) => {
      const { result } = await continueSession(deps.delivery(), {
        actor,
        target,
        answer: { kind: 'prompt', text },
        dryRun: false
      })
      return record('continue', target, result.summary, 'It stopped with work left')
    },
    ask: async (target, question) => {
      const { result } = await queueQuestion(deps.delivery(), {
        actor,
        target,
        question,
        dryRun: false
      })
      return record('ask', target, result.summary, 'Unclear whether it is finished')
    },
    archive: async (target, reason = STEWARD_TIER2_REASON) => {
      const summary = `Archived “${target.title}”: ${reason}.`
      await relayOrganizationChange(
        deps.ledger(),
        deps.relay,
        {
          opId: randomUUID(),
          kind: 'archive',
          targets: [{ paneKey: target.paneKey, ...(target.tabId ? { tabId: target.tabId } : {}) }],
          value: true,
          executor: { kind: 'app', feature: 'steward' },
          reason
        },
        { actor: auditActor(actor), summary }
      )
      return summary
    },
    close: async (target, { exited = false, unchanged } = {}) => {
      const where = { paneKey: target.paneKey, ...(target.tabId ? { tabId: target.tabId } : {}) }
      // Why here: `relayOrganizationMutation` admits nothing itself; this is the rule asked again.
      const evidence = await admitUnattendedOrganization(actor, {
        kind: 'delete',
        value: true,
        targets: [where]
      })
      if (!evidence) {
        throw new Error('the blank-session rule gave no evidence, so nothing was closed')
      }
      // Why before the relay: the pane's process is named while its tab still holds it.
      const stopped = deps.stopWatch?.(target) ?? (async () => 'unconfirmed' as const)
      const result = await relayOrganizationMutation(deps.ledger(), deps.relay, {
        op: { kind: 'deleteSession', ...where },
        executor: { kind: 'app', feature: 'steward' },
        reason: STEWARD_EMPTY_SESSION_CLOSE_REASON,
        evidence,
        actor: auditActor(actor),
        // Why: a close cannot be put back, so the last keystroke check is the one before it goes.
        beforeRelay: () =>
          unchanged && !unchanged()
            ? 'a prompt or keystroke reached it just before it was closed'
            : null
      })
      const stop =
        exited || result.tabClose === 'declined'
          ? 'no-process'
          : await stopped(STEWARD_STOP_RECEIPT_MS).catch(() => 'unconfirmed' as const)
      return closeSummary(target.title, result.tabClose, exited, stop)
    }
  }
}
