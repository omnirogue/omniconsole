import { randomUUID } from 'node:crypto'
import type {
  ArtifactCloudOperation,
  ArtifactCloudOptions,
  ArtifactListOptions,
  ArtifactListPage,
  ArtifactListItem,
  ArtifactPublishedLink,
  ArtifactPublishResult,
  ArtifactWriteRequest
} from '../../shared/artifacts'
import type {
  ArtifactLifecycleRequest,
  ArtifactReviewStatus,
  ArtifactReviewCloseRequest,
  ArtifactReviewStatusRequest
} from '../../shared/artifact-review'
import type { ArtifactSessionRecord } from '../../shared/artifact-session'
import { assertArtifactSharingAllowed } from '../../shared/artifact-sharing-gate'
import { ensureActiveOrcaProfile } from '../omni-profiles/profile-index-store'
import { getOrcaCloudAuthConfig } from '../omni-profiles/profile-cloud-auth-config'
import { prepareArtifactCloudUse } from '../omni-profiles/profile-artifact-cloud-cleanup'
import { runWithFreshOrcaCloudSession } from '../omni-profiles/profile-cloud-session-refresh'
import {
  allowsArtifactCloudAuthOverride,
  resolveArtifactCloudApiUrl,
  artifactCloudApiOriginOrNull
} from './artifact-cloud-config'
import { getArtifactShareRecord, removeArtifactShareRecords } from './artifact-share-record-store'
import {
  storedSessionAuthContext,
  explicitTokenAuthContext,
  type ArtifactAuthContext
} from './artifact-cloud-auth-context'
import { artifactRequest, deleteArtifactRequest } from './artifact-cloud-request'
import {
  changeArtifactLifecycle,
  closeArtifactReview,
  fetchArtifactReviewStatus,
  resolveArtifactReviewSlug
} from './artifact-review-status'
import { listArtifactSessionRecords } from './artifact-session-records'
import { ArtifactPublisher } from './artifact-publisher'
import { isFirstPartyCloudHost, THIRD_PARTY_CLOUD_MESSAGE } from './artifact-cloud-first-party'
import type { SessionContextDocumentSnapshot } from '../../shared/session-context-documents'
import { readArtifactContext } from './artifact-context-reader'
import { searchOmniosDocuments, type ArtifactContextSearchPage } from './omnios-document-search'

export function artifactListQuery(options: Pick<ArtifactListOptions, 'cursor' | 'state'>): string {
  const params = [
    ...(options.cursor ? [`cursor=${encodeURIComponent(options.cursor)}`] : []),
    ...(options.state ? [`state=${encodeURIComponent(options.state)}`] : [])
  ]
  return params.length > 0 ? `?${params.join('&')}` : ''
}

export class ArtifactCloudService {
  private readonly publisher: ArtifactPublisher

  /**
   * `isSharingEnabled` is the publish capability gate. It is read per call, never cached, so
   * revoking it in Settings takes effect on the next request. List, unshare, and delete stay
   * ungated: a user who turns publishing off must still be able to audit and revoke old links.
   */
  constructor(
    private readonly userDataPath: string,
    private readonly isSharingEnabled: () => boolean
  ) {
    this.publisher = new ArtifactPublisher(userDataPath)
  }

  list(options: ArtifactListOptions): Promise<ArtifactCloudOperation<ArtifactListPage>> {
    return this.withAuth(options, async (token, apiUrl) => {
      return artifactRequest<ArtifactListPage>(apiUrl, token, artifactListQuery(options))
    })
  }

  readContextDocument(
    slug: string
  ): Promise<ArtifactCloudOperation<SessionContextDocumentSnapshot>> {
    return this.withAuth({}, (token, apiUrl) => readArtifactContext(apiUrl, token, slug))
  }

  searchContextDocuments(
    query: string,
    cursor?: string
  ): Promise<ArtifactCloudOperation<ArtifactContextSearchPage>> {
    return this.withAuth({}, (token, apiUrl) => searchOmniosDocuments(apiUrl, token, query, cursor))
  }

  getPublishedLink(
    request: ArtifactCloudOptions & { sourceKey: string }
  ): Promise<ArtifactCloudOperation<ArtifactPublishedLink | null>> {
    return this.withAuth(request, async (_token, _apiUrl, auth) => {
      const record = getArtifactShareRecord(
        auth.profileId,
        this.userDataPath,
        request.sourceKey,
        auth.scope
      )
      return record ? { shareUrl: record.shareUrl } : null
    })
  }

  // Why async: the gate must surface as a rejection, not a synchronous throw, so every caller's
  // promise chain handles it the same way.
  async share(request: ArtifactWriteRequest): Promise<ArtifactCloudOperation<ArtifactListItem>> {
    assertArtifactSharingAllowed(this.isSharingEnabled)
    const idempotencyKey = randomUUID()
    return this.withAuth(request, (token, apiUrl, auth) =>
      this.publisher.share(request, token, apiUrl, auth, idempotencyKey)
    )
  }

  async publish(
    request: ArtifactWriteRequest
  ): Promise<ArtifactCloudOperation<ArtifactPublishResult>> {
    assertArtifactSharingAllowed(this.isSharingEnabled)
    const idempotencyKey = randomUUID()
    return this.withAuth(request, (token, apiUrl, auth) =>
      this.publisher.publish(request, token, apiUrl, auth, idempotencyKey)
    )
  }

  async update(request: ArtifactWriteRequest): Promise<ArtifactCloudOperation<ArtifactListItem>> {
    assertArtifactSharingAllowed(this.isSharingEnabled)
    return this.withAuth(request, (token, apiUrl, auth) =>
      this.publisher.runForSource(request.sourceKey, auth, async () => {
        auth.assertCurrent()
        const record = getArtifactShareRecord(
          auth.profileId,
          this.userDataPath,
          request.sourceKey,
          auth.scope
        )
        if (!record) {
          throw new Error('This file has not been shared from the active OmniConsole profile.')
        }
        return this.publisher.updateExisting(request, token, apiUrl, auth, record)
      })
    )
  }

  unshare(
    request: ArtifactCloudOptions & { sourceKey: string }
  ): Promise<ArtifactCloudOperation<void>> {
    return this.withAuth(request, (token, apiUrl, auth) =>
      this.publisher.runForSource(request.sourceKey, auth, async () => {
        auth.assertCurrent()
        const record = getArtifactShareRecord(
          auth.profileId,
          this.userDataPath,
          request.sourceKey,
          auth.scope
        )
        if (!record) {
          throw new Error('This file has not been shared from the active OmniConsole profile.')
        }
        return this.publisher.runForSlug(record.slug, auth, async () => {
          auth.assertCurrent()
          await deleteArtifactRequest(apiUrl, token, `/${record.slug}`, record.editToken)
          auth.assertCurrent()
          removeArtifactShareRecords(auth.profileId, this.userDataPath, auth.scope, {
            sourceKey: request.sourceKey,
            slug: record.slug
          })
        })
      })
    )
  }

  /** Read-only, so it is not gated by the publish capability. */
  reviewStatus(
    request: ArtifactReviewStatusRequest
  ): Promise<ArtifactCloudOperation<ArtifactReviewStatus>> {
    return this.withAuth(request, (token, apiUrl, auth) =>
      fetchArtifactReviewStatus(this.userDataPath, request, token, apiUrl, auth)
    )
  }

  /** The server lets only the page's owner close it. */
  closeReview(
    request: ArtifactReviewCloseRequest
  ): Promise<ArtifactCloudOperation<ArtifactReviewStatus>> {
    return this.withAuth(request, (token, apiUrl, auth) => {
      // Why serialized on one resolved slug: an update resets the review to pending.
      const slug = resolveArtifactReviewSlug(this.userDataPath, auth, request)
      return this.publisher.runForSlug(slug, auth, () =>
        closeArtifactReview(
          this.userDataPath,
          { slug, ...(request.reason ? { reason: request.reason } : {}) },
          token,
          apiUrl,
          auth
        )
      )
    })
  }

  /** Owner only on the server; serialized with updates since an update reopens a closed page. */
  lifecycle(
    slug: string,
    body: ArtifactLifecycleRequest,
    options: ArtifactCloudOptions = {}
  ): Promise<ArtifactCloudOperation<ArtifactReviewStatus>> {
    return this.withAuth(options, (token, apiUrl, auth) =>
      this.publisher.runForSlug(slug, auth, () =>
        changeArtifactLifecycle(slug, body, token, apiUrl, auth)
      )
    )
  }

  /** Local share records for session previews, without edit tokens; ungated like `list`. */
  /** The artifact origin, or null when it is misconfigured. */
  apiOrigin(): string | null {
    return artifactCloudApiOriginOrNull()
  }

  sessionRecords(): ArtifactSessionRecord[] {
    return listArtifactSessionRecords(this.userDataPath)
  }

  delete(id: string, options: ArtifactCloudOptions): Promise<ArtifactCloudOperation<void>> {
    return this.withAuth(options, (token, apiUrl, auth) =>
      this.publisher.runForSlug(id, auth, async () => {
        auth.assertCurrent()
        await deleteArtifactRequest(apiUrl, token, `/${encodeURIComponent(id)}`)
        auth.assertCurrent()
        removeArtifactShareRecords(auth.profileId, this.userDataPath, auth.scope, { slug: id })
      })
    )
  }

  /** A signed-in call for the review sleep reports and the review inbox; ungated like `list`. */
  signedIn<T>(operation: (token: string, apiUrl: string) => Promise<T>): Promise<ArtifactCloudOperation<T>> {
    return this.withAuth({}, (token, apiUrl) => operation(token, apiUrl))
  }

  private async withAuth<T>(
    options: ArtifactCloudOptions,
    operation: (token: string, apiUrl: string, auth: ArtifactAuthContext) => Promise<T>
  ): Promise<ArtifactCloudOperation<T>> {
    const apiUrl = resolveArtifactCloudApiUrl(options.apiUrl)
    const active = ensureActiveOrcaProfile(this.userDataPath)
    prepareArtifactCloudUse(active.profile, this.userDataPath)
    if (options.authToken?.trim()) {
      if (!allowsArtifactCloudAuthOverride()) {
        throw new Error(
          'Artifact authentication overrides are available only in development builds.'
        )
      }
      const token = options.authToken.trim()
      const auth = explicitTokenAuthContext(active, apiUrl, token, this.userDataPath)
      const value = await operation(token, apiUrl, auth)
      auth.assertCurrent()
      return {
        status: 'ok',
        value
      }
    }
    const config = getOrcaCloudAuthConfig()
    if (!config.configured) {
      return { status: 'unconfigured', message: config.setupMessage }
    }
    if (!isFirstPartyCloudHost(apiUrl, config.config.apiBaseUrl)) {
      // Why: never send the omnios token to a third-party host — and never let
      // that host's 401 be read as an expired sign-in (it cleared sessions).
      return { status: 'unconfigured', message: THIRD_PARTY_CLOUD_MESSAGE }
    }
    const result = await runWithFreshOrcaCloudSession(
      config.config,
      active,
      this.userDataPath,
      async (session) => {
        const auth = storedSessionAuthContext(active, apiUrl, this.userDataPath)
        const value = await operation(session.accessToken, apiUrl, auth)
        auth.assertCurrent()
        return value
      }
    )
    return result.status === 'ok'
      ? { status: 'ok', value: result.value }
      : { status: 'reconnect-required' }
  }
}
