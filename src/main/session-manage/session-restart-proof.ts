/**
 * A restart from a checkpoint (`session restart`, and `session resume`'s `restarted`) succeeds only
 * once the new pane's agent hooks report the same conversation, the proof `resumed` already needs.
 * A tab alone is `started_unconfirmed`, with the reason, and its checkpoint is kept (on the new
 * tab's pane, or back on the old one) so the conversation can be restarted again.
 */

import type { LaunchCause } from '../../shared/launch-cause'
import type {
  SessionManageResumeReply,
  SessionManageSidebarRow
} from '../../shared/session-manage-relay'
import {
  rowHoldsSessionReference,
  sessionReferenceForRow,
  transcriptSessionIdOf,
  type SessionReferenceTarget
} from '../../shared/session-reference'
import type { SessionRestartOutcome } from '../../shared/session-resume-types'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import type { SessionResumeVerdict } from './session-manage-resume'

export const SESSION_RESUME_CONFIRM_TIMEOUT_MS = 30_000
const CONFIRM_POLL_MS = 1_000

/** Polls the pane's agent hook reports until one names a conversation, or the window ends. */
export async function confirmPaneConversation(
  runtime: Pick<OrcaRuntimeService, 'getReportedProviderSessionsForPane'>,
  reference: SessionReferenceTarget,
  paneKeyNow: () => Promise<string | null>,
  signal?: AbortSignal
): Promise<SessionResumeVerdict> {
  const deadline = Date.now() + SESSION_RESUME_CONFIRM_TIMEOUT_MS
  for (;;) {
    const paneKey = await paneKeyNow()
    // Only the agent's own hook reports count: the tab's launch intent is not proof.
    const reported = paneKey ? runtime.getReportedProviderSessionsForPane(paneKey)[0] : undefined
    if (paneKey && reported) {
      const same = rowHoldsSessionReference(reference, {
        hostId: 'local',
        providerSessionId: reported.id,
        transcriptPath: reported.transcriptPath ?? null
      })
      return same ? { state: 'same', paneKey } : { state: 'different', reported: reported.id }
    }
    if (Date.now() >= deadline || signal?.aborted) {
      return { state: 'unconfirmed' }
    }
    await new Promise((resolve) => setTimeout(resolve, CONFIRM_POLL_MS))
  }
}

export type SessionRestartProofDeps = {
  resume(
    target: { paneKey?: string; tabId?: string; keepCheckpoint: true },
    launchCause?: LaunchCause
  ): Promise<SessionManageResumeReply>
  /** Waits for the restarted pane's agent hooks to report which conversation it opened. */
  confirmRestarted(
    reference: SessionReferenceTarget,
    paneKey: string
  ): Promise<SessionResumeVerdict>
  /** Unconfirmed: the checkpoint the window set aside stays on the new pane or the old one. */
  keepCheckpoint(tabId: string, onto: 'launched' | 'original'): Promise<boolean>
}

export type SessionRestartProof = {
  outcome: SessionRestartOutcome
  summary: string
  reason?: string
}

export async function restartWithHookProof(
  deps: SessionRestartProofDeps,
  row: SessionManageSidebarRow,
  name: string,
  launchCause?: LaunchCause
): Promise<SessionRestartProof> {
  const reply = await deps.resume(
    {
      ...(row.paneKey ? { paneKey: row.paneKey } : {}),
      ...(row.tabId ? { tabId: row.tabId } : {}),
      keepCheckpoint: true
    },
    launchCause
  )
  const sessionId =
    row.providerSessionId ?? (row.transcriptPath ? transcriptSessionIdOf(row.transcriptPath) : null)
  const verdict =
    sessionId && reply.paneKey
      ? await deps.confirmRestarted(
          { sessionId, hostId: 'local', transcriptPath: row.transcriptPath ?? null },
          reply.paneKey
        )
      : null
  if (verdict?.state === 'same') {
    return {
      outcome: 'restarted',
      summary: `Resumed ${name} in a new tab (pane ${verdict.paneKey}): the same conversation, confirmed by its agent. Nothing was re-sent.`
    }
  }
  const reason = !sessionId
    ? 'its checkpoint names no conversation to check against'
    : !verdict
      ? 'its new pane could not be named'
      : verdict.state === 'different'
        ? `its agent reported a different conversation (${verdict.reported})`
        : `its agent did not report which conversation it opened within ${SESSION_RESUME_CONFIRM_TIMEOUT_MS / 1000} s`
  // Why the old pane for another conversation or an unnamed pane: the new one does not hold it.
  const onto = verdict?.state === 'different' || !reply.paneKey ? 'original' : 'launched'
  const kept = reply.tabId ? await deps.keepCheckpoint(reply.tabId, onto).catch(() => false) : false
  const ref = sessionReferenceForRow(row)
  return {
    outcome: 'started_unconfirmed',
    reason,
    summary: `${name} was started again in a new tab${reply.tabId ? ` (tab ${reply.tabId})` : ''}, but ${reason}, so the resume is unconfirmed; check that tab before sending it anything.${kept ? (onto === 'launched' ? ' Its checkpoint was kept on that tab, so it can be restarted from there.' : ' Its checkpoint was put back on its old pane, so it can be restarted from there.') : ''}${ref ? ` If it did not resume, omni session resume --ref ${ref} reopens it from its transcript.` : ''}`
  }
}
