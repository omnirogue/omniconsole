import type { ArtifactListItem, ArtifactMetadata } from '../../../../shared/artifacts'
import {
  isArtifactCollectAsk,
  type ArtifactLifecycle,
  type ArtifactLifecycleRequest
} from '../../../../shared/artifact-review'
import { translate } from '@/i18n/i18n'
import {
  artifactCurrentDecision,
  artifactItemHasLifecycle,
  artifactRevision,
  isArtifactClosed,
  isArtifactReviewPage
} from './artifact-lifecycle-model'

export type ArtifactLifecycleActionKey =
  | 'markDone'
  | 'noAction'
  | 'supersede'
  | 'reopen'
  | 'removeSuccessor'
  | 'openSession'

export type ArtifactActionAvailability = 'enabled' | 'disabled' | 'hidden'

/** One matrix for the row menu, the context menu and the drawer, so they cannot drift. */
export function artifactLifecycleActionAvailability(
  item: ArtifactListItem
): Record<ArtifactLifecycleActionKey, ArtifactActionAvailability> {
  const openSession = item.sessionRef ? 'enabled' : 'hidden'
  if (!artifactItemHasLifecycle(item) || artifactRevision(item) === null) {
    return {
      markDone: 'hidden',
      noAction: 'hidden',
      supersede: 'hidden',
      reopen: 'hidden',
      removeSuccessor: 'hidden',
      openSession
    }
  }
  const review = isArtifactReviewPage(item)
  const closed = isArtifactClosed(item)
  // Why: a review or study is answered, never approved, so its owner may close it done anyway.
  const mayFinish =
    isArtifactCollectAsk(item.artifact.review) ||
    artifactCurrentDecision(item)?.decision === 'approved'
  const { lifecycle, closedAt, supersededBy, supersededAt } = item.artifact
  return {
    markDone: !review ? 'hidden' : mayFinish && !closed ? 'enabled' : 'disabled',
    noAction: !review ? 'hidden' : closed ? 'disabled' : 'enabled',
    supersede: supersededBy ? 'hidden' : 'enabled',
    reopen: !lifecycle ? 'hidden' : closedAt ? 'enabled' : 'disabled',
    removeSuccessor: !supersededBy ? 'hidden' : supersededAt ? 'enabled' : 'disabled',
    openSession
  }
}

export function artifactCloseRequest(
  item: ArtifactListItem,
  lifecycle: ArtifactLifecycle,
  options: { bulk?: boolean } = {}
): ArtifactLifecycleRequest | null {
  const revision = artifactRevision(item)
  if (revision === null) {
    return null
  }
  return { action: 'close', revision, lifecycle, ...(options.bulk ? { expect: 'open' } : {}) }
}

export function artifactSupersedeRequest(
  item: ArtifactListItem,
  by: string,
  options: { bulk?: boolean } = {}
): ArtifactLifecycleRequest | null {
  const revision = artifactRevision(item)
  if (revision === null || by === item.artifact.slug) {
    return null
  }
  return { action: 'supersede', revision, by, ...(options.bulk ? { expect: 'unsuperseded' } : {}) }
}

/** Reopen with the closure's own undo token; null when the page is not closed. */
export function artifactReopenRequest(artifact: ArtifactMetadata): ArtifactLifecycleRequest | null {
  if (typeof artifact.revision !== 'number' || !artifact.lifecycle || !artifact.closedAt) {
    return null
  }
  return { action: 'reopen', revision: artifact.revision, closedAt: artifact.closedAt }
}

export function artifactUnsupersedeRequest(
  artifact: ArtifactMetadata
): ArtifactLifecycleRequest | null {
  if (typeof artifact.revision !== 'number' || !artifact.supersededBy || !artifact.supersededAt) {
    return null
  }
  return {
    action: 'unsupersede',
    revision: artifact.revision,
    by: artifact.supersededBy,
    supersededAt: artifact.supersededAt
  }
}

/** The exact inverse of a close or supersede, read from the page the server returned. */
export function artifactUndoRequest(
  action: ArtifactLifecycleRequest['action'],
  after: ArtifactMetadata
): ArtifactLifecycleRequest | null {
  if (action === 'close') {
    return artifactReopenRequest(after)
  }
  if (action === 'supersede') {
    return artifactUnsupersedeRequest(after)
  }
  return null
}

// Why: every 409 the lifecycle route answers; the main process appends the code to its message.
const CONFLICT_CODES = new Set([
  'stale_revision',
  'not_a_review',
  'already_closed',
  'review_closed',
  'needs_approval',
  'already_superseded',
  'successor_invalid',
  'not_closed',
  'not_superseded',
  'stale_closure',
  'expect_failed',
  'study_answers_shown'
])

export const ARTIFACT_LIFECYCLE_UNSUPPORTED = 'lifecycle_unsupported'

/** The server `code` behind a failed `artifacts.lifecycle` call, when there is one. */
export function artifactLifecycleErrorCode(error: unknown): string | null {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (/cannot change lifecycle yet/i.test(message)) {
    return ARTIFACT_LIFECYCLE_UNSUPPORTED
  }
  const code = /\(([a-z_]+)\)\.?\s*$/.exec(message)?.[1] ?? null
  return code && CONFLICT_CODES.has(code) ? code : null
}

/** A conflict means the page moved under the caller; it is reported, never retried. */
export function isArtifactLifecycleConflict(code: string | null): boolean {
  return code !== null && CONFLICT_CODES.has(code)
}

export function artifactLifecycleErrorWords(code: string | null): string {
  if (code === null) {
    return artifactLifecycleErrorWordsFor('')
  }
  return artifactLifecycleErrorWordsFor(code)
}

function artifactLifecycleErrorWordsFor(code: string): string {
  switch (code) {
    case 'stale_revision':
    case 'stale_closure':
    case 'expect_failed':
      return translate(
        'auto.components.artifacts.lifecycle.errorStale',
        'This page changed since you loaded it. Refresh.'
      )
    case 'needs_approval':
      return translate(
        'auto.components.artifacts.lifecycle.errorNeedsApproval',
        'Mark done needs an approved decision on the current revision.'
      )
    case 'review_closed':
    case 'already_closed':
    case 'already_superseded':
      return translate('auto.components.artifacts.lifecycle.errorClosed', 'Already closed.')
    case 'successor_invalid':
      return translate(
        'auto.components.artifacts.lifecycle.errorSuccessor',
        'That page cannot be the successor.'
      )
    case 'study_answers_shown':
      return translate(
        'auto.components.artifacts.lifecycle.errorStudyAnswersShown',
        'Its answers were shown when it closed, so this study stays closed. Publish a new study for the people still to answer.'
      )
    case ARTIFACT_LIFECYCLE_UNSUPPORTED:
      return translate(
        'auto.components.artifacts.lifecycle.errorUnsupported',
        'This OmniConsole server cannot change lifecycle yet.'
      )
    default:
      return translate(
        'auto.components.artifacts.lifecycle.errorGeneric',
        'Could not change this page.'
      )
  }
}
