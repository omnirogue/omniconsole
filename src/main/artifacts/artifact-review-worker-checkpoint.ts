import { getProfileUserDataPath } from '../omni-profiles/profile-storage-paths'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { isEquivalentPaneKey } from '../runtime/orchestration/db/pane-key-match'
import type { WorkerTerminalResourceRow } from '../runtime/orchestration/worker-terminal-ownership'
import {
  getArtifactShareRecord,
  listArtifactShareRecords,
  type ArtifactShareScope
} from './artifact-share-record-store'
import { activeArtifactShareScope } from './artifact-share-scope'
import { validArtifactSourceReview, type ArtifactSourceReview } from './artifact-source-review'

export type WorkerReviewHandoff = {
  version: 1
  profileId: string
  scope: ArtifactShareScope
  entries: { sourceKey: string; slug: string; sourceReview: ArtifactSourceReview }[]
}

export function reviewBoundToWorker(
  binding: ArtifactSourceReview,
  resource: WorkerTerminalResourceRow
): boolean {
  return (
    resource.pane_key !== null &&
    binding.worktreeId === resource.worktree_id &&
    isEquivalentPaneKey(binding.paneKey, resource.pane_key)
  )
}

/** Pin only the review identities in the existing output archive, never edit tokens. */
export function captureWorkerReviewHandoff(
  runtime: OrcaRuntimeService,
  resource: WorkerTerminalResourceRow
): WorkerReviewHandoff | null {
  const userDataPath = getProfileUserDataPath()
  const active = activeArtifactShareScope(userDataPath, runtime.getArtifactApiOrigin())
  if (!active) {
    return null
  }
  const entries = listArtifactShareRecords(active.profileId, userDataPath, active.scope).flatMap(
    ([sourceKey, record]) =>
      validArtifactSourceReview(record.sourceReview) &&
      reviewBoundToWorker(record.sourceReview, resource)
        ? [{ sourceKey, slug: record.slug, sourceReview: record.sourceReview }]
        : []
  )
  return entries.length ? { version: 1, ...active, entries } : null
}

export function readWorkerReviewHandoff(content: string): WorkerReviewHandoff | null | undefined {
  const value = JSON.parse(content).reviewHandoff as WorkerReviewHandoff | null | undefined
  if (value === undefined || value === null) {
    return value
  }
  if (
    value.version !== 1 ||
    typeof value.profileId !== 'string' ||
    !value.profileId ||
    !value.scope ||
    !['cloudUserId', 'cloudProfileId', 'cloudOrganizationId', 'apiOrigin'].every(
      (key) => typeof value.scope[key as keyof ArtifactShareScope] === 'string'
    ) ||
    !Array.isArray(value.entries) ||
    !value.entries.every(
      (entry) =>
        typeof entry.sourceKey === 'string' &&
        typeof entry.slug === 'string' &&
        validArtifactSourceReview(entry.sourceReview)
    )
  ) {
    throw new Error('Worker review handoff checkpoint is invalid; preserve its release obligation.')
  }
  return value
}

/** Compare the frozen binding, while the share store remains the review's authority. */
function withoutReceipt(review: ArtifactSourceReview | undefined): unknown {
  if (!review) {
    return review
  }
  const { receipt: _receipt, ...binding } = review
  return binding
}

export function workerReviewRecords(
  handoff: WorkerReviewHandoff,
  userDataPath: string,
  options: { afterExit?: boolean } = {}
) {
  return handoff.entries.map((entry) => {
    const record = getArtifactShareRecord(
      handoff.profileId,
      userDataPath,
      entry.sourceKey,
      handoff.scope
    )
    // After exit, a newer revision may use the same archived conversation, never a new binding.
    const current = record?.sourceReview
    const expected =
      options.afterExit &&
      validArtifactSourceReview(current) &&
      current.revision > entry.sourceReview.revision
        ? { ...entry.sourceReview, revision: current.revision }
        : entry.sourceReview
    if (
      !record ||
      record.slug !== entry.slug ||
      JSON.stringify(withoutReceipt(record.sourceReview)) !==
        JSON.stringify(withoutReceipt(expected))
    ) {
      throw new Error('Worker review binding changed; keep its execution or recovery available.')
    }
    return { entry, record }
  })
}
