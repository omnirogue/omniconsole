/**
 * What one review delivery pass works under: the active profile's cloud scope and account, the
 * wake helpers, and which share records still belong to it. The answer-delivery claimer's review
 * adapter reads the same context, so both paths apply the same wake guards.
 */

import { consolePublicationPrincipal } from '../backoffice/console-workflow-person'
import { ensureActiveOrcaProfile } from '../omni-profiles/profile-index-store'
import { prepareArtifactCloudUse } from '../omni-profiles/profile-artifact-cloud-cleanup'
import { ledgerSourceForSession } from '../session-ledger/ledger-lookup'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import {
  validArtifactReviewSleep,
  type ArtifactReviewSleep
} from '../../shared/artifact-review-sleep'
import { resolveArtifactCloudApiUrl } from './artifact-cloud-config'
import { getArtifactShareRecord } from './artifact-share-record-store'
import { runtimeReviewWakeDeps } from './artifact-review-wake-runtime'
import { runtimeReviewCloseDeps } from './artifact-review-reject-runtime'
import { workerReviewDeliveryHeld } from './artifact-review-worker-release'
import type { SourceReviewEntry } from './artifact-source-review-watch'
import type { WakeCopyApi } from './review-wake-copy-api'
import { runtimeWakeClaimDeps } from './review-wake-claim-owner-runtime'

export type ArtifactReviewStatusReader = Parameters<typeof runtimeReviewCloseDeps>[0]['status']

export function reviewPassContext(
  userDataPath: string,
  runtime: OrcaRuntimeService,
  wakeApi: WakeCopyApi,
  status: ArtifactReviewStatusReader
) {
  const active = ensureActiveOrcaProfile(userDataPath)
  prepareArtifactCloudUse(active.profile, userDataPath)
  const cloud = active.profile.cloud
  if (!cloud) {
    return null
  }
  const scope = {
    cloudUserId: cloud.userId,
    cloudProfileId: cloud.cloudProfileId,
    cloudOrganizationId: cloud.activeOrgId ?? '',
    apiOrigin: resolveArtifactCloudApiUrl()
  }
  const account = consolePublicationPrincipal(scope.apiOrigin, scope.cloudUserId)
  const profileId = active.profile.id
  /** Same profile, cloud and account, and no worker close in flight for this binding. */
  const unchanged = (entry: SourceReviewEntry): boolean => {
    const now = ensureActiveOrcaProfile(userDataPath)
    return !(
      now.profile.id !== profileId ||
      now.profile.cloud?.userId !== cloud.userId ||
      now.profile.cloud.cloudProfileId !== cloud.cloudProfileId ||
      (now.profile.cloud.activeOrgId ?? '') !== scope.cloudOrganizationId ||
      resolveArtifactCloudApiUrl() !== scope.apiOrigin ||
      entry.sourceReview.account !== account ||
      workerReviewDeliveryHeld(runtime.getOrchestrationDb(), entry.sourceReview)
    )
  }
  const current = (entry: SourceReviewEntry): boolean => {
    if (!unchanged(entry)) {
      return false
    }
    const binding = entry.sourceReview
    const owner = ledgerSourceForSession(binding.paneKey, account)
    const saved = getArtifactShareRecord(profileId, userDataPath, entry.sourceKey, scope)
    const { receipt: _savedReceipt, ...savedIdentity } = saved?.sourceReview ?? {}
    const { receipt: _receipt, ...identity } = binding
    // Why: a slept pane can leave the ledger (tab closed, registry full); the wake checks the
    // conversation id itself and moves the binding before anything is delivered.
    const sleptAway =
      !owner &&
      validArtifactReviewSleep(saved?.sleep) &&
      saved.sleep.revision === binding.revision &&
      ['asleep', 'waking', 'stalled'].includes(saved.sleep.state)
    return (
      ((owner?.ledgerId === binding.ledgerId &&
        owner.nativeSessionId === binding.nativeSessionId) ||
        sleptAway) &&
      saved?.slug === entry.slug &&
      JSON.stringify(savedIdentity) === JSON.stringify(identity)
    )
  }
  const baseWake = runtimeReviewWakeDeps({ runtime, userDataPath, profileId, scope, account })
  const closing = { runtime, userDataPath, profileId, scope, status }
  const wake = {
    ...baseWake,
    ...runtimeWakeClaimDeps({
      runtime,
      api: wakeApi,
      readRows: baseWake.readRows,
      observe: baseWake.observe,
      archiveRow: runtimeReviewCloseDeps({ ...closing, wake: baseWake }).archiveRow,
      saveSleep: baseWake.saveSleep,
      windowAttached: () => runtime.getStatus().desktopWindowStatus === 'available',
      now: baseWake.now
    })
  }
  const sleepOf = (entry: SourceReviewEntry): ArtifactReviewSleep | undefined => {
    const sleep = getArtifactShareRecord(profileId, userDataPath, entry.sourceKey, scope)?.sleep
    return validArtifactReviewSleep(sleep) ? sleep : undefined
  }
  return { profileId, scope, account, unchanged, current, baseWake, closing, wake, sleepOf }
}

export type ReviewPassContext = NonNullable<ReturnType<typeof reviewPassContext>>
