import { useEffect, useState } from 'react'
import type { ArtifactReviewStatus } from '../../../../../shared/artifact-review'
import { createArtifactReviewPoller } from './artifact-review-poller'
import { fetchSessionArtifactReview } from './session-artifact-client'

/**
 * The server's current title, revision and review state for one artifact, re-checked about every
 * 15 s while `visible`. Hidden, it stops polling entirely.
 */
export function useArtifactReview(
  slug: string | null,
  visible: boolean
): ArtifactReviewStatus | null {
  const [review, setReview] = useState<{ slug: string; status: ArtifactReviewStatus } | null>(null)
  useEffect(() => {
    if (!slug || !visible) {
      return
    }
    const poller = createArtifactReviewPoller({
      load: () => fetchSessionArtifactReview(slug),
      onResult: (status) => {
        // Why keep the last good answer on a failed check: a blip must not blank the header.
        if (status) {
          setReview({ slug, status })
        }
      }
    })
    poller.start()
    return () => poller.stop()
  }, [slug, visible])
  return review && review.slug === slug ? review.status : null
}
