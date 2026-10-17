import type { ArtifactWriteRequest, ArtifactMetadata } from '../../shared/artifacts'
import { consolePublicationPrincipal } from '../backoffice/console-workflow-person'
import { ledgerSourceForSession } from '../session-ledger/ledger-lookup'
import { artifactSessionOriginOf } from './artifact-session-origin'
import type { ArtifactShareScope } from './artifact-share-record-store'

import type { ArtifactSourceReview } from './artifact-source-review'

/** Pin the publishing conversation before any network await; a pane alone can be reused. */
export function artifactSourceReview(
  request: ArtifactWriteRequest,
  scope: ArtifactShareScope
): Omit<ArtifactSourceReview, 'revision'> | null {
  const origin = artifactSessionOriginOf(request)
  if (!origin?.paneKey || !origin.worktreeId) {
    return null
  }
  const account = consolePublicationPrincipal(scope.apiOrigin, scope.cloudUserId)
  const source = ledgerSourceForSession(origin.paneKey, account)
  if (!source?.nativeSessionId) {
    return null
  }
  return {
    ledgerId: source.ledgerId,
    nativeSessionId: source.nativeSessionId,
    paneKey: origin.paneKey,
    worktreeId: origin.worktreeId,
    account
  }
}

export function sourceReviewForRevision(
  source: Omit<ArtifactSourceReview, 'revision'> | null,
  artifact: ArtifactMetadata
): ArtifactSourceReview | undefined {
  const revision = artifact.revision
  return source && artifact.review && Number.isSafeInteger(revision) && revision! > 0
    ? { ...source, revision: revision! }
    : undefined
}
