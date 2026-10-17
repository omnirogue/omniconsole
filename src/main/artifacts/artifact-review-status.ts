import type {
  ArtifactLifecycleRequest,
  ArtifactReviewCloseRequest,
  ArtifactReviewStatus,
  ArtifactReviewStatusRequest
} from '../../shared/artifact-review'
import { OrcaCloudRequestError } from '../omni-profiles/profile-cloud-client'
import { artifactRequest } from './artifact-cloud-request'
import { type ArtifactShareScope, getArtifactShareRecord } from './artifact-share-record-store'

type ArtifactReviewAuthContext = {
  profileId: string
  scope: ArtifactShareScope
  assertCurrent: () => void
}

/**
 * A share record for the local file wins, using the same path + profile rule as `update`.
 * A raw slug is the fallback so an agent can also check a link it only has the id of.
 */
export function resolveArtifactReviewSlug(
  userDataPath: string,
  auth: Pick<ArtifactReviewAuthContext, 'profileId' | 'scope'>,
  request: Pick<ArtifactReviewStatusRequest, 'sourceKey' | 'slug'>
): string {
  if (request.sourceKey) {
    const record = getArtifactShareRecord(
      auth.profileId,
      userDataPath,
      request.sourceKey,
      auth.scope
    )
    if (record) {
      return record.slug
    }
  }
  if (request.slug) {
    return request.slug
  }
  throw new Error(
    request.sourceKey
      ? 'This file has not been shared from the active OmniConsole profile.'
      : 'Pass a shared file or an artifact id.'
  )
}

export async function fetchArtifactReviewStatus(
  userDataPath: string,
  request: ArtifactReviewStatusRequest,
  token: string,
  apiUrl: string,
  auth: ArtifactReviewAuthContext
): Promise<ArtifactReviewStatus> {
  auth.assertCurrent()
  const slug = resolveArtifactReviewSlug(userDataPath, auth, request)
  try {
    const status = await artifactRequest<ArtifactReviewStatus>(
      apiUrl,
      token,
      `/${encodeURIComponent(slug)}/review`
    )
    auth.assertCurrent()
    return status
  } catch (error) {
    if (error instanceof OrcaCloudRequestError && error.statusCode === 404) {
      throw new Error(
        error.errorCode === 'artifact_not_found'
          ? `Artifact ${slug} was not found for the signed-in OmniConsole account.`
          : `Artifact ${slug} was not found, or this OmniConsole server does not support artifact reviews yet.`
      )
    }
    throw error
  }
}

/** Withdraws the review: it leaves the Decisions list and a late decision is refused. */
export async function closeArtifactReview(
  userDataPath: string,
  request: ArtifactReviewCloseRequest,
  token: string,
  apiUrl: string,
  auth: ArtifactReviewAuthContext
): Promise<ArtifactReviewStatus> {
  auth.assertCurrent()
  const slug = resolveArtifactReviewSlug(userDataPath, auth, request)
  try {
    const status = await artifactRequest<ArtifactReviewStatus>(
      apiUrl,
      token,
      `/${encodeURIComponent(slug)}/review/close`,
      { method: 'POST', body: { status: 'withdrawn', reason: request.reason ?? '' } }
    )
    auth.assertCurrent()
    return status
  } catch (error) {
    if (error instanceof OrcaCloudRequestError && error.statusCode === 404) {
      throw new Error(
        error.errorCode === 'artifact_not_found'
          ? `Artifact ${slug} was not found for the signed-in OmniConsole account.`
          : error.errorCode
            ? `Artifact ${slug} has no open review to close (${error.errorCode}).`
            : 'This OmniConsole server cannot close reviews yet.'
      )
    }
    throw error
  }
}

// Why words: the CLI prints these to an agent that must decide whether to re-read and retry.
const LIFECYCLE_CONFLICTS: Record<string, string> = {
  stale_revision: 'the page has a newer revision; read its status and try again',
  not_a_review: 'only a review page can be closed',
  already_closed: 'the page is already closed',
  needs_approval: 'closing as done needs an approval on the current revision',
  already_superseded: 'the page already has a successor',
  successor_invalid:
    'the successor must be another live page you can view, not superseded, and not pointing back here',
  not_closed: 'the page is not closed',
  not_superseded: 'the page does not have that successor',
  stale_closure: 'the closure changed since it was read; read its status and try again',
  expect_failed: 'the page changed since it was selected'
}

function lifecycleErrorMessage(slug: string, error: OrcaCloudRequestError): string | null {
  if (error.statusCode === 404) {
    return error.errorCode === 'artifact_not_found' || error.errorCode === 'not_found'
      ? `Artifact ${slug} was not found for the signed-in OmniConsole account.`
      : 'This OmniConsole server cannot change lifecycle yet.'
  }
  if (error.statusCode === 403) {
    return `Only the owner of artifact ${slug} can change its lifecycle.`
  }
  if (error.statusCode === 409 && error.errorCode) {
    const reason = LIFECYCLE_CONFLICTS[error.errorCode] ?? 'the server refused the change'
    return `Artifact ${slug}: ${reason} (${error.errorCode}).`
  }
  if (error.statusCode === 400) {
    return `The OmniConsole server rejected the lifecycle request for ${slug}${error.errorCode ? ` (${error.errorCode})` : ''}.`
  }
  return null
}

/** Closes, supersedes, reopens or unsupersedes a page; answers the updated status document. */
export async function changeArtifactLifecycle(
  slug: string,
  body: ArtifactLifecycleRequest,
  token: string,
  apiUrl: string,
  auth: Pick<ArtifactReviewAuthContext, 'assertCurrent'>
): Promise<ArtifactReviewStatus> {
  auth.assertCurrent()
  try {
    const status = await artifactRequest<ArtifactReviewStatus>(
      apiUrl,
      token,
      `/${encodeURIComponent(slug)}/lifecycle`,
      { method: 'POST', body }
    )
    auth.assertCurrent()
    return status
  } catch (error) {
    const message =
      error instanceof OrcaCloudRequestError ? lifecycleErrorMessage(slug, error) : null
    if (message) {
      throw new Error(message)
    }
    throw error
  }
}
