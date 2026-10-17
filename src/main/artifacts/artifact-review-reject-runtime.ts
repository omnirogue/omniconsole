import { conversationSourceRowKey } from '../../shared/conversation-source'
import { validArtifactReviewSleep } from '../../shared/artifact-review-sleep'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { sessionManageSource } from '../session-manage/session-manage-observe'
import { sessionActionsLogFor } from '../session-manage/session-actions-log'
import { sessionOrganizationLedgerFor } from '../session-organization/organization-change-ledger'
import { relayOrganizationMutation } from '../session-organization/organization-relayed-mutation'
import { getSessionDecisionStore } from '../session-questions/session-decision-wiring'
import { saveArtifactReviewSleep } from './artifact-share-record-sleep'
import { listArtifactShareRecords, type ArtifactShareScope } from './artifact-share-record-store'
import type { endReviewWaitWithoutDecision, ReviewRejectDeps } from './artifact-review-reject'
import { readReviewSessionCleanupHold } from './artifact-review-cleanup-hold'
import { purgeConversationTranscripts } from './artifact-review-transcript-purge'
import { purgeSessionWorkspace } from './artifact-review-workspace-purge'
import type { ReviewWakeDeps } from './artifact-review-wake'
import { artifactLifecycleSnapshot, type ArtifactReviewStatus } from '../../shared/artifact-review'
import { readSidebarRows } from '../session-manage/session-manage-runtime-actions'
import { readConversationOrganization } from '../session-manage/session-manage-resume-runtime'

const STILL_OPEN = new Set(['waiting', 'asleep', 'waking', 'awake', 'stalled'])

export function runtimeReviewRejectDeps(input: {
  runtime: OrcaRuntimeService
  userDataPath: string
  profileId: string
  scope: ArtifactShareScope
  wake: Pick<ReviewWakeDeps, 'observe' | 'now'>
  /** The page's saved review, for pages this conversation published with no wait recorded. */
  status(slug: string): Promise<ArtifactReviewStatus | null>
}): ReviewRejectDeps {
  const { runtime, userDataPath, profileId, scope, wake } = input
  return {
    // Why the window's own listing: a delete never acts on the owner's remembered rows.
    readWindowRows: () => readSidebarRows(runtime, { requireReady: true }),
    observe: wake.observe,
    windowAttached: () => runtime.getStatus().desktopWindowStatus === 'available',
    paneParked: async (row) =>
      row.paneKey !== null &&
      runtime.getTerminalHandleForPaneKey(row.paneKey) === null &&
      (await runtime
        .requestSessionFolders({ kind: 'paneParkedBySleep', paneKey: row.paneKey })
        .then((answer) => answer === true)
        .catch(() => false)),
    conversationDeleted: async (sessionId) =>
      (await readConversationOrganization(runtime, { hostId: 'local', sessionId }))?.deleted ===
      true,
    protection: (target) => readReviewSessionCleanupHold(runtime, target),
    otherOpenReviews: async (entry) => {
      const open: string[] = []
      for (const [sourceKey, record] of listArtifactShareRecords(profileId, userDataPath, scope)) {
        if (
          sourceKey === entry.sourceKey ||
          record.sourceReview?.nativeSessionId !== entry.sourceReview.nativeSessionId
        ) {
          continue
        }
        if (
          validArtifactReviewSleep(record.sleep) &&
          record.sleep.revision === record.sourceReview.revision
        ) {
          if (STILL_OPEN.has(record.sleep.state)) {
            open.push(record.slug)
          }
          continue
        }
        // No wait recorded (--keep-session, or one refused): ask the page; unknown counts as open.
        const status = await input.status(record.slug).catch(() => null)
        const closed = status ? artifactLifecycleSnapshot(status).lifecycle !== null : false
        if (
          !status ||
          (!closed && ['pending', 'approved', 'changes_requested'].includes(status.status ?? ''))
        ) {
          open.push(record.slug)
        }
      }
      return open
    },
    deleteRow: async (row, reason, evidence) => {
      const result = await relayOrganizationMutation(
        sessionOrganizationLedgerFor(userDataPath),
        (request) => runtime.requestSessionFolders(request),
        {
          op: {
            kind: 'deleteSession',
            ...(row.paneKey ? { paneKey: row.paneKey } : {}),
            ...(row.tabId ? { tabId: row.tabId } : {}),
            // Why not force: the window refuses a session that turned busy since main's check.
            purge: true
          },
          executor: { kind: 'app', feature: 'artifact-review' },
          reason,
          evidence,
          actor: { actor: 'artifact-review' }
        }
      )
      return result.tabClose ?? 'unverified'
    },
    purgeStores: async (rows, sessionId) => {
      const cleared: string[] = []
      const panes = new Set(rows.flatMap((row) => (row.paneKey ? [row.paneKey] : [])))
      let queued = 0
      for (const row of rows) {
        const source = sessionManageSource(row)
        if (!source) {
          continue
        }
        const rowKey = conversationSourceRowKey(source)
        for (const entry of runtime.readPromptQueue(rowKey)?.entries ?? []) {
          // An entry mid-send cannot be taken back; the closed pane refuses it anyway.
          if (entry.state !== 'sending' && runtime.removePromptQueueEntry(rowKey, entry.id)) {
            queued += 1
          }
        }
      }
      if (queued) {
        cleared.push(`${queued} queued prompt${queued === 1 ? '' : 's'}`)
      }
      const decisions = getSessionDecisionStore()
      const asked = (decisions?.list() ?? []).filter(
        (record) => panes.has(record.paneKey) || record.providerSession?.id === sessionId
      )
      for (const record of asked) {
        decisions?.remove(record.key)
      }
      if (asked.length) {
        cleared.push(`${asked.length} Needs You decision${asked.length === 1 ? '' : 's'}`)
      }
      let chains = 0
      for (const chain of runtime.listSessionChains()) {
        if (chain.sourcePaneKey && panes.has(chain.sourcePaneKey)) {
          try {
            chains += runtime.removeSessionChain(chain.id) ? 1 : 0
          } catch {
            // A committed outcome must be revised explicitly; it stays, named in the record.
            cleared.push(`(kept committed outcome chain ${chain.id})`)
          }
        }
      }
      if (chains) {
        cleared.push(`${chains} outcome chain${chains === 1 ? '' : 's'}`)
      }
      return cleared
    },
    purgeTranscripts: (provider, sessionId, transcriptPath) =>
      purgeConversationTranscripts(provider, sessionId, {
        userDataPath,
        ...(transcriptPath ? { transcriptPath } : {})
      }),
    purgeWorkspace: (target) => purgeSessionWorkspace(runtime, target),
    saveSleep: (entry, sleep) =>
      saveArtifactReviewSleep(profileId, userDataPath, entry.sourceKey, scope, entry, sleep),
    audit: async (entry, decision, summary) => {
      await sessionActionsLogFor(userDataPath).appendStrict({
        actor: 'artifact-review',
        action: 'session.delete',
        target: { paneKey: entry.sourceReview.paneKey },
        summary,
        artifactReview: {
          slug: entry.slug,
          revision: decision.revision,
          decisionId: String(decision.id),
          by: decision.by.email || decision.by.name
        }
      })
    },
    now: wake.now
  }
}

export function runtimeReviewCloseDeps(
  input: Parameters<typeof runtimeReviewRejectDeps>[0]
): Parameters<typeof endReviewWaitWithoutDecision>[0] {
  const { runtime, userDataPath, profileId, scope } = input
  const reject = runtimeReviewRejectDeps(input)
  return {
    readWindowRows: reject.readWindowRows,
    observe: reject.observe,
    windowAttached: reject.windowAttached,
    protection: reject.protection,
    otherOpenReviews: reject.otherOpenReviews,
    archiveRow: async (row, reason) => {
      await relayOrganizationMutation(
        sessionOrganizationLedgerFor(userDataPath),
        (request) => runtime.requestSessionFolders(request),
        {
          op: {
            kind: 'archiveSession',
            ...(row.paneKey ? { paneKey: row.paneKey } : {}),
            ...(row.tabId ? { tabId: row.tabId } : {}),
            archived: true
          },
          executor: { kind: 'app', feature: 'artifact-review' },
          reason,
          actor: { actor: 'artifact-review' }
        }
      )
    },
    clearSleep: (entry) => {
      saveArtifactReviewSleep(profileId, userDataPath, entry.sourceKey, scope, entry, null)
    }
  }
}
