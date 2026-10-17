/**
 * What each review pass tells OmniOS besides delivering decisions: this computer's heartbeat
 * before the pass, then (Phase 2) a wake copy for each newly asleep wait, then every changed state.
 */

import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import type { ArtifactCloudService } from './artifact-cloud-service'
import { artifactRequest } from './artifact-cloud-request'
import {
  markArtifactReviewReopened,
  saveArtifactReviewWakeCopy
} from './artifact-share-record-sleep'
import type { ArtifactShareScope } from './artifact-share-record-store'
import { runtimeReviewRowReader } from './artifact-review-wake-runtime'
import { conversationRunning, runtimePaneParked } from './review-wake-claim-owner-runtime'
import { activeArtifactShareScope } from './artifact-share-scope'
import { listReviewSleepEntries } from './artifact-review-sleep-targets'
import { createSourceStateReporter, sourceStateResult } from './artifact-source-state-report'
import { wakeCopyApi } from './review-wake-copy-api'
import { createWakeCopyUploads, reviewHost } from './review-wake-copy-pass'

export function sourceReviewReports(
  service: ArtifactCloudService,
  userDataPath: string,
  runtime: OrcaRuntimeService
): { before(): Promise<void>; after(): Promise<void> } {
  const entries = () => listReviewSleepEntries(service.apiOrigin(), userDataPath)
  const scoped = <T>(write: (active: { profileId: string; scope: ArtifactShareScope }) => T) => {
    const active = activeArtifactShareScope(userDataPath, service.apiOrigin())
    return active ? write(active) : false
  }
  const rows = runtimeReviewRowReader(runtime)
  // Why one reporter across passes: it sends each state once per change, not every minute.
  const reporter = createSourceStateReporter({
    entries,
    host: reviewHost,
    windowAttached: () => runtime.getStatus().desktopWindowStatus === 'available',
    post: async (path, body) => {
      try {
        const sent = await service.signedIn((token, apiUrl) =>
          artifactRequest(apiUrl, token, path, { method: 'POST', body })
        )
        return sent.status === 'ok' ? 'ok' : 'failed'
      } catch (error) {
        return sourceStateResult(error)
      }
    },
    now: () => Date.now()
  })
  const uploads = createWakeCopyUploads({
    api: wakeCopyApi(service),
    entries,
    saveWakeCopy: (entry, wakeCopy) =>
      scoped((active) =>
        saveArtifactReviewWakeCopy(
          active.profileId,
          userDataPath,
          entry.sourceKey,
          active.scope,
          entry,
          wakeCopy
        )
      ),
    markReopened: (entry) =>
      scoped((active) =>
        markArtifactReviewReopened(
          active.profileId,
          userDataPath,
          entry.sourceKey,
          active.scope,
          entry
        )
      ),
    running: conversationRunning({
      ...rows,
      // A wait that ran again since it slept is marked reopened and never copied.
      paneParked: runtimePaneParked(runtime, rows.windowAttached)
    }),
    beat: () => reporter.heartbeat().catch(() => {}),
    now: () => Date.now()
  })
  return {
    before: () => reporter.heartbeat().catch(() => {}),
    after: async () => {
      await uploads().catch(() => {})
      await reporter.states().catch(() => {})
    }
  }
}
