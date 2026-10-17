import { normalizeLaunchCause, type LaunchCause } from '../../shared/launch-cause'
import { attemptLaunchProvenance } from '../launch-ledger/launch-provenance-guard'
/**
 * An exited waiter is resumed before it is woken. When the session another one waited on has its
 * result, the waiter's next step continues the SAME conversation; if that conversation's agent
 * exited meanwhile (or its tab was closed), the steward resumes it through #751's
 * `resumeConversation` — the same conversation, confirmed by its agent — and the step is delivered
 * there. A waiter that cannot be resumed reads Stalled, with the reason, instead of "gone".
 */

import type { ConversationSource } from '../../shared/conversation-source'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type { SessionManageActor, SessionManageEntry } from '../../shared/session-manage-types'
import {
  formatSessionReference,
  isSessionReferenceAgent,
  parseSessionReference,
  rowsForSessionReference
} from '../../shared/session-reference'
import type { SessionResumeResult } from '../../shared/session-resume-types'
import {
  installSameConversationReviver,
  type SameConversationRevival
} from '../runtime/session-outcome-conversation-revive'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { auditActor, sessionActionsLogFor } from '../session-manage/session-actions-log'
import { toSessionManageEntry } from '../session-manage/session-manage-inventory'
import { remoteExecutionRefusal } from '../session-manage/session-manage-locality'
import { observeSession } from '../session-manage/session-manage-observe'
import { resumeConversation } from '../session-manage/session-manage-resume'
import { runtimeResumeDeps } from '../session-manage/session-manage-resume-runtime'
import { readSidebarRows } from '../session-manage/session-manage-runtime-actions'
import { createRuntimeObserveSources } from '../session-manage/session-manage-runtime-sources'
import { stewardFeatureOn } from './steward-switches'

const STEWARD: SessionManageActor = { kind: 'steward', feature: 'rules' }

export type WaiterResumeDeps = {
  enabled(): boolean
  readRows(): Promise<SessionManageSidebarRow[]>
  observe(row: SessionManageSidebarRow): Promise<SessionManageEntry>
  /** The provider conversation the pane's agent last reported, as a `--ref`; null when none. */
  reportedRef(paneKey: string): string | null
  resume(ref: string, chain?: SessionChain): Promise<SessionResumeResult>
  audit(summary: string, target: { paneKey: string | null; title: string }): void
}

/** A plan that waits on any event (a session's result, a Jira reply, a time); others keep rule 1. */
function waitsOnEvent(chain: SessionChain): boolean {
  return Boolean(
    chain.outcomeSet?.outcomes.some((outcome) =>
      outcome.conditions.some(
        (condition) => condition.event !== undefined && condition.event !== null
      )
    )
  )
}

function stalled(reason: string): SameConversationRevival {
  return { kind: 'stalled', reason: `Stalled: ${reason}` }
}

function sourceOf(row: SessionManageSidebarRow): ConversationSource {
  return row.kind === 'structured' && row.structuredSessionId
    ? {
        worktreeId: row.worktreeId,
        paneKey: row.paneKey!,
        kind: 'structured',
        sessionId: row.structuredSessionId
      }
    : { worktreeId: row.worktreeId, paneKey: row.paneKey!, kind: 'pty' }
}

/** The pane the resumed conversation now lives in: the one holding its ref, not the exited one. */
async function resumedSource(
  deps: WaiterResumeDeps,
  ref: string,
  exitedPaneKey: string
): Promise<ConversationSource | null> {
  const reference = parseSessionReference(ref)
  if (!reference) {
    return null
  }
  const rows = rowsForSessionReference(
    reference,
    (await deps.readRows()).filter(
      (row) => !row.folded && row.paneKey !== null && row.paneKey !== exitedPaneKey
    )
  )
  return rows.length === 1 ? sourceOf(rows[0]!) : null
}

export async function reviveWaiter(
  deps: WaiterResumeDeps,
  chain: SessionChain,
  source: ConversationSource | null
): Promise<SameConversationRevival | null> {
  if (!waitsOnEvent(chain) || !deps.enabled()) {
    return null
  }
  const paneKey = chain.sourcePaneKey
  const rows = await deps.readRows().catch(() => null)
  if (!rows) {
    // No window can say whether it exited; a live pane still gets the route's own readings.
    return source
      ? null
      : stalled('the waiting session is closed and no OmniConsole window could reopen it.')
  }
  const row = rows.find((entry) => !entry.folded && entry.paneKey === paneKey)
  let ref: string | null
  let title = paneKey
  if (row) {
    title = row.title
    const remote = remoteExecutionRefusal({ title: row.title, hostId: row.hostId }, 'resume')
    if (remote) {
      return source ? null : stalled(remote)
    }
    const entry = await deps.observe(row)
    // Live or unverifiable: nothing to resume; loss of contact is never evidence of an exit.
    if (entry.verdict !== 'exited') {
      return null
    }
    ref = entry.ref ?? null
  } else if (source) {
    return null
  } else {
    ref = deps.reportedRef(paneKey)
  }
  if (!ref) {
    return stalled(
      `“${title}” exited and its agent never reported which conversation it was, so it cannot be resumed. Reopen it, or plan this step as a new agent.`
    )
  }
  // Why re-read: S1's unattended gate does not see this in-process resume; the switch is its gate,
  // and it may have been turned off while the rows were read.
  if (!deps.enabled()) {
    return null
  }
  let result: SessionResumeResult
  try {
    result = await deps.resume(ref, chain)
  } catch (error) {
    return stalled(
      `“${title}” exited and could not be resumed: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  deps.audit(`Resumed the waiting session so its next step can continue it: ${result.summary}`, {
    paneKey: result.paneKey ?? null,
    title
  })
  const resumed =
    result.paneKey && result.paneKey !== paneKey
      ? ((await deps.readRows().catch(() => []))
          .filter((entry) => entry.paneKey === result.paneKey)
          .map(sourceOf)[0] ?? null)
      : await resumedSource(deps, ref, paneKey)
  return resumed
    ? { kind: 'resumed', source: resumed }
    : stalled(
        `“${title}” was resumed (${result.summary}) but its new pane has not reported yet; this step is retried.`
      )
}

type Runtime = Parameters<typeof readSidebarRows>[0] &
  Parameters<typeof createRuntimeObserveSources>[0] &
  Parameters<typeof runtimeResumeDeps>[0] &
  Pick<OrcaRuntimeService, 'getReportedProviderSessionsForPane' | 'getLastAgentHookRowForPane'>

export function runtimeWaiterResumeDeps(runtime: Runtime, userDataPath: string): WaiterResumeDeps {
  return {
    enabled: () => stewardFeatureOn('sessionWaits'),
    readRows: () => readSidebarRows(runtime),
    observe: async (row) =>
      toSessionManageEntry(await observeSession(row, createRuntimeObserveSources(runtime))),
    reportedRef: (paneKey) => {
      const session = runtime.getReportedProviderSessionsForPane(paneKey)[0]
      const agent = runtime.getLastAgentHookRowForPane(paneKey)?.agentType?.toLowerCase()
      return session && isSessionReferenceAgent(agent)
        ? formatSessionReference({ agent, sessionId: session.id, hostId: 'local' })
        : null
    },
    resume: (ref, chain) =>
      resumeConversation(
        runtimeResumeDeps(runtime, {
          userDataPath,
          launchCause: attemptLaunchProvenance<LaunchCause>(
            'steward-resume',
            () =>
              normalizeLaunchCause({
                trigger: 'steward-resume',
                actor: { kind: 'app' },
                ...(chain
                  ? { reference: { outcomeChainId: chain.id }, parentPaneKey: chain.sourcePaneKey }
                  : {})
              }),
            { trigger: 'unknown' }
          ),
          // Why: a waiter woken for its reply must not stay filed under Archived.
          unarchive: { feature: 'steward', actor: 'steward', reason: 'Its wait was answered' }
        }),
        {
          actor: STEWARD,
          ref,
          dryRun: false
        }
      ),
    audit: (summary, target) => {
      void sessionActionsLogFor(userDataPath)
        .append({ ...auditActor(STEWARD), action: 'resume', target, summary })
        .catch(() => {})
    }
  }
}

/** Main calls this once at startup; the returned function uninstalls it. */
export function startWaiterResume(userDataPath: string): () => void {
  return installSameConversationReviver((runtime, chain, source) =>
    reviveWaiter(runtimeWaiterResumeDeps(runtime, userDataPath), chain, source)
  )
}
