/**
 * One page OmniOS lists as a wake this computer may claim (CONTRACT.md, Phase 2), and the shape
 * check every listing gets first: owners and claimers update separately, so an item a newer owner
 * describes differently is skipped, never trusted.
 */

import type { ArtifactReviewDecision } from '../../shared/artifact-review'
import type { WakeCopyWorkspace } from './review-wake-copy-pack'

export type WakeCandidate = {
  slug: string
  title: string
  revision: number
  shareUrl?: string
  decision: ArtifactReviewDecision
  ownerHost: string
  claimableAt: string
  requirements: {
    provider: 'claude' | 'codex'
    providerVersion: string | null
    workspace: WakeCopyWorkspace
  }
  copy: { sha256: string; bytes: number; parts: number }
}

export function validCandidate(item: WakeCandidate): boolean {
  const workspace = item?.requirements?.workspace
  return (
    typeof item.slug === 'string' &&
    Number.isSafeInteger(item.revision) &&
    (item.requirements.provider === 'claude' || item.requirements.provider === 'codex') &&
    ((workspace?.kind === 'folder' && typeof workspace.workRelativePath === 'string') ||
      (workspace?.kind === 'git' &&
        typeof workspace.remoteUrl === 'string' &&
        typeof workspace.branch === 'string' &&
        typeof workspace.commit === 'string'))
  )
}
