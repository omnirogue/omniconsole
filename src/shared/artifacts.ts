import type {
  ArtifactAudience,
  ArtifactLifecycleFields,
  ArtifactPublishWarning,
  ArtifactReviewDecision,
  ArtifactReviewInfo,
  ArtifactReviewRequest
} from './artifact-review'
import type { ArtifactWriteOrigin } from './artifact-session'

export const ARTIFACT_CLI_MAX_RPC_BYTES = 800 * 1024

export function artifactWriteRequestByteLength(request: ArtifactWriteRequest): number {
  return new TextEncoder().encode(JSON.stringify(request)).byteLength
}

export type ArtifactMetadata = {
  version: 1
  slug: string
  title: string | null
  originalFileName: string | null
  sourceContentType: string
  renderedContentType: 'text/html'
  createdAt: string
  updatedAt: string
  expiresAt: string
  byteSize: number
  deletedAt: string | null
  // Why optional: servers without review support omit these fields.
  audience?: string
  revision?: number
  review?: ArtifactReviewInfo | null
} & ArtifactLifecycleFields

export type ArtifactLastDecision = Pick<ArtifactReviewDecision, 'revision' | 'decision' | 'at'>

export type ArtifactListItem = {
  artifact: ArtifactMetadata
  shareUrl: string
  // Why optional: servers before the lifecycle release omit these fields.
  /** Per viewer: an open review still pending that the viewer has not retired. */
  needsYou?: boolean
  lastDecision?: ArtifactLastDecision | null
  /** The `als_` ledger id of the publishing session, when known. */
  sessionRef?: string | null
  sessionAgent?: string | null
  /** Only on a share or update response, and only when OmniOS had something to say. */
  warnings?: ArtifactPublishWarning[]
}

/** Server-side filter for `GET /v1/artifacts`; absent means every live page. */
export const ARTIFACT_LIST_STATES = ['open', 'closed', 'needs_me'] as const
export type ArtifactListState = (typeof ARTIFACT_LIST_STATES)[number]

export type ArtifactListPage = {
  artifacts: readonly ArtifactListItem[]
  nextCursor?: string
}

export type ArtifactWriteRequest = {
  sourceKey: string
  content: string
  contentType: 'text/html' | 'text/markdown'
  fileName: string
  title?: string
  review?: ArtifactReviewRequest
  audience?: ArtifactAudience
  /** The IDE terminal that ran the command; kept locally, never sent to the server. */
  origin?: ArtifactWriteOrigin
  /** Main process only: why the command's terminal was not bound; an update clears the old one. */
  unboundReason?: string
  /** Main process only: the terminal's conversation when the caller was verified, pinned to publish. */
  verifiedSession?: { ledgerId?: string; nativeSessionId?: string }
  apiUrl?: string
  authToken?: string
}

export type ArtifactPublishResult = {
  change: 'created' | 'updated'
  item: ArtifactListItem
}

export type ArtifactPublishedLink = {
  shareUrl: string
}

export type ArtifactCloudOptions = {
  apiUrl?: string
  authToken?: string
}

export type ArtifactListOptions = ArtifactCloudOptions & {
  cursor?: string
  state?: ArtifactListState
}

export type ArtifactCloudOperation<T> =
  | { status: 'ok'; value: T }
  | { status: 'reconnect-required' }
  | { status: 'unconfigured'; message: string }
