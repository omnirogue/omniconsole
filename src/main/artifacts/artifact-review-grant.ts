import { basename, extname, isAbsolute } from 'node:path'
import {
  ARTIFACT_AUDIENCES,
  ARTIFACT_REVIEWERS_MAX,
  type ArtifactAudience,
  type ArtifactReviewStatus
} from '../../shared/artifact-review'
import type {
  ArtifactCloudOperation,
  ArtifactListItem,
  ArtifactWriteRequest
} from '../../shared/artifacts'
import type { ArtifactSessionRecord } from '../../shared/artifact-session'
import { ARTIFACT_CLI_MAX_RPC_BYTES } from '../../shared/artifacts'
import { readArtifactFileWithinLimit } from '../../shared/artifact-file-read'
import type { HandoffArtifactReview } from '../../shared/handoff-artifact-review'
import type { ArtifactReviewGrantResult } from '../backoffice/handoff-artifact-review-send'

/** The part of `ArtifactCloudService` a grant uses; a test passes its own. */
export type ArtifactReviewGrantService = {
  reviewStatus: (request: { slug: string }) => Promise<ArtifactCloudOperation<ArtifactReviewStatus>>
  sessionRecords: () => ArtifactSessionRecord[]
  update: (request: ArtifactWriteRequest) => Promise<ArtifactCloudOperation<ArtifactListItem>>
}

export type ArtifactReviewGrantIo = {
  readSource: typeof readArtifactFileWithinLimit
}

const DEFAULT_IO: ArtifactReviewGrantIo = { readSource: readArtifactFileWithinLimit }

function contentTypeOf(path: string): ArtifactWriteRequest['contentType'] | null {
  const extension = extname(path).toLowerCase()
  return ['.html', '.htm'].includes(extension)
    ? 'text/html'
    : ['.md', '.markdown'].includes(extension)
      ? 'text/markdown'
      : null
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const refused = (message: string): ArtifactReviewGrantResult => ({
  ok: false,
  message,
  permanent: true
})
const later = (message: string): ArtifactReviewGrantResult => ({
  ok: false,
  message,
  permanent: false
})

/**
 * Make `reviewer` (an emp_ id) a named reviewer of the page, so they can decide on it signed in.
 *
 * Nothing is decided here: this only publishes the same page again through the existing
 * `update --review` path with the person added to its reviewers, keeping its question, audience
 * and title. A page that already names them is left untouched, which is what makes a replayed
 * send harmless. Only the page's owner can do this, from the computer that published it (the
 * update needs the page's source); anything else is refused with what to do instead.
 */
export async function grantArtifactReviewer(
  service: ArtifactReviewGrantService,
  input: { review: HandoffArtifactReview; reviewer: string },
  io: ArtifactReviewGrantIo = DEFAULT_IO
): Promise<ArtifactReviewGrantResult> {
  const { review, reviewer } = input
  const name = `“${review.title}”`
  let read: ArtifactCloudOperation<ArtifactReviewStatus>
  try {
    read = await service.reviewStatus({ slug: review.slug })
  } catch (error) {
    const message = errorText(error)
    // A missing page will not appear by asking again; a network failure might pass.
    return /not found/i.test(message) ? refused(message) : later(message)
  }
  if (read.status === 'unconfigured') {
    return refused(read.message)
  }
  if (read.status === 'reconnect-required') {
    return later(`Sign in to OmniConsole again so ${name} can be shared for review.`)
  }
  const status = read.value
  const current = status.artifact.review ?? null
  const reviewers = current?.reviewers ?? []
  // The server stores reviewers lower-cased and matches them the same way.
  if (reviewers.some((entry) => entry.toLowerCase() === reviewer.toLowerCase())) {
    return { ok: true }
  }
  if (!status.viewer.isOwner) {
    return refused(
      `Only the person who published ${name} can add a reviewer to it. Ask them to add this person, or send it without the page.`
    )
  }
  if (reviewers.length >= ARTIFACT_REVIEWERS_MAX) {
    return refused(
      `${name} already has ${ARTIFACT_REVIEWERS_MAX} reviewers, the most a page can have.`
    )
  }
  const record = service.sessionRecords().find((entry) => entry.slug === review.slug)
  const sourceKey = record?.sourceKey
  const contentType = sourceKey ? contentTypeOf(sourceKey) : null
  if (!sourceKey || !isAbsolute(sourceKey) || !contentType) {
    return refused(
      `${name} was not published from this computer, so its reviewers cannot be changed here. Where it was published, run: omni artifacts update --file <its file> --review --reviewers ${reviewer}`
    )
  }
  const source = await io.readSource(sourceKey, ARTIFACT_CLI_MAX_RPC_BYTES)
  if (source.status !== 'ok') {
    return refused(
      source.status === 'too-large'
        ? `${name} is too large to publish again from here.`
        : `The file ${name} was published from is no longer readable (${sourceKey}).`
    )
  }
  const audience = (ARTIFACT_AUDIENCES as readonly string[]).includes(
    status.artifact.audience ?? ''
  )
    ? (status.artifact.audience as ArtifactAudience)
    : undefined
  let written: ArtifactCloudOperation<ArtifactListItem>
  try {
    written = await service.update({
      sourceKey,
      content: source.content,
      contentType,
      fileName: status.artifact.originalFileName || basename(sourceKey),
      // Why each is carried: a PUT without them would clear the title, and a review without an
      // audience would move a restricted page to the whole team.
      ...(status.artifact.title ? { title: status.artifact.title } : {}),
      ...(audience ? { audience } : {}),
      review: {
        ...(current?.question ? { question: current.question } : {}),
        reviewers: [...reviewers, reviewer]
      }
    })
  } catch (error) {
    return later(errorText(error))
  }
  if (written.status === 'unconfigured') {
    return refused(written.message)
  }
  if (written.status === 'reconnect-required') {
    return later(`Sign in to OmniConsole again so ${name} can be shared for review.`)
  }
  return { ok: true }
}
