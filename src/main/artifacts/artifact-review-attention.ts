import {
  artifactLifecycleSnapshot,
  isArtifactReviewResolved,
  type ArtifactReviewStatus
} from '../../shared/artifact-review'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import type { ArtifactCloudOperation } from '../../shared/artifacts'
import type { ReviewSleepEntry } from './artifact-review-sleep-targets'

/** A server observation, independent of whether the publishing session can take its result. */
export type ArtifactReviewAttention = {
  revision: number
  needsYou: boolean
  status: string | null
  observedAt: number
}

export function validArtifactReviewAttention(value: unknown): value is ArtifactReviewAttention {
  const row = value as Partial<ArtifactReviewAttention> | null
  return Boolean(
    row &&
    Number.isSafeInteger(row.revision) &&
    row.revision! > 0 &&
    typeof row.needsYou === 'boolean' &&
    (row.status === null || typeof row.status === 'string') &&
    typeof row.observedAt === 'number' &&
    Number.isFinite(row.observedAt)
  )
}

export function readArtifactReviewAttention(
  slug: string,
  status: ArtifactReviewStatus,
  observedAt: number
): ArtifactReviewAttention | null {
  const revision = status.artifact.revision
  if (status.artifact.slug !== slug || !Number.isSafeInteger(revision) || revision! < 1) {
    return null
  }
  const lifecycle = artifactLifecycleSnapshot(status)
  const closed = Boolean(
    status.artifact.deletedAt ||
    lifecycle.lifecycle ||
    lifecycle.supersededBy ||
    isArtifactReviewResolved(status.status)
  )
  if (!closed && typeof status.needsYou !== 'boolean' && status.status !== 'pending') {
    return null
  }
  return {
    revision: revision!,
    needsYou: !closed && status.needsYou !== false && status.viewer.retired !== true,
    status: status.status,
    observedAt
  }
}

/** Failed/missing reads retain the last observation; absence from a limited inbox proves nothing. */
export async function reconcileReviewAttention(
  entries: readonly ReviewSleepEntry[],
  deps: {
    read(slug: string): Promise<ArtifactCloudOperation<ArtifactReviewStatus>>
    save(entry: ReviewSleepEntry, attention: ArtifactReviewAttention): boolean
    current(): boolean
    observed?(slug: string, attention: ArtifactReviewAttention): void
    now?: () => number
  }
): Promise<ReviewSleepEntry[]> {
  const bySlug = new Map<string, ReviewSleepEntry[]>()
  for (const entry of entries) {
    const group = bySlug.get(entry.slug) ?? []
    group.push(entry)
    bySlug.set(entry.slug, group)
  }
  const observations = new Map<string, ArtifactReviewAttention>()
  await mapWithConcurrency([...bySlug], 4, async ([slug, group]) => {
    if (!deps.current()) {
      return
    }
    const observedAt = (deps.now ?? Date.now)()
    try {
      const read = await deps.read(slug)
      if (read.status !== 'ok' || !deps.current()) {
        return
      }
      const attention = readArtifactReviewAttention(slug, read.value, observedAt)
      if (!attention) {
        return
      }
      for (const entry of group) {
        const previous = entry.reviewAttention
        if (
          attention.revision < entry.sleep.revision ||
          (previous &&
            (attention.revision < previous.revision || attention.observedAt < previous.observedAt))
        ) {
          continue
        }
        if (deps.save(entry, attention)) {
          observations.set(entry.sourceKey, attention)
          deps.observed?.(slug, attention)
        }
      }
    } catch {
      // The previous observation survives network, authentication and persistence failures.
    }
  })
  return entries.map((entry) => {
    const reviewAttention = observations.get(entry.sourceKey)
    return reviewAttention ? { ...entry, reviewAttention } : entry
  })
}
