import { z } from 'zod'
import type { ArtifactCloudOptions, ArtifactMetadata } from './artifacts'
import { isCredentialFreeHttpsUrl, type ArtifactProposal } from './artifact-proposal'

// Why: mirrors the OmniConsole server contract for review artifacts. The server is the
// authority; these limits only let the CLI fail fast with a clear message.
export const ARTIFACT_AUDIENCES = ['public', 'team', 'reviewers'] as const
export type ArtifactAudience = (typeof ARTIFACT_AUDIENCES)[number]
export const ARTIFACT_REVIEW_QUESTION_MAX_CHARS = 500
export const ARTIFACT_REVIEW_SUMMARY_MAX_CHARS = 1200
export const ARTIFACT_REVIEW_OPTIONS_MIN = 2
export const ARTIFACT_REVIEW_OPTIONS_MAX = 8
export const ARTIFACT_REVIEW_OPTION_LABEL_MAX_CHARS = 160
export const ARTIFACT_REVIEW_OPTION_DETAIL_MAX_CHARS = 600
export const ARTIFACT_REVIEWERS_MAX = 20
export const ARTIFACT_REVIEW_CATEGORY_MAX_CHARS = 40
export const ARTIFACT_REVIEW_WAIT_MAX_SECONDS = 600
export const ARTIFACT_SLUG_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

/** A one-click answer on the review page. */
export type ArtifactReviewOption = {
  label: string
  detail?: string
  recommended?: true
}

export type ArtifactReviewRequest = {
  question?: string
  reviewers?: string[]
  context?: ArtifactProposal
  summary?: string
  options?: ArtifactReviewOption[]
  /** Lets the reviewer pick more than one option; needs `options`. */
  multi?: true
  /** The category decides who may answer; the server maps free text to a registered slug. */
  about?: { category: string }
}

/** A non-refusing publish note from OmniOS (`category_missing`, an unreachable reviewer, …). */
export type ArtifactPublishWarning = { code: string; hint: string }

export type ArtifactReviewFields = {
  review?: ArtifactReviewRequest
  audience?: ArtifactAudience
}

export type ArtifactReviewState = 'pending' | 'approved' | 'changes_requested' | 'rejected'

/** Unknown future states are not proof that a human has handled the review. */
export function isArtifactReviewResolved(status: string | null | undefined): boolean {
  return ['approved', 'changes_requested', 'rejected', 'withdrawn'].includes(status ?? '')
}

export type ArtifactReviewInfo = {
  question: string
  reviewers: string[]
  status: ArtifactReviewState
  statusAt: string | null
  context?: ArtifactProposal
  summary?: string
  options?: ArtifactReviewOption[]
  multi?: true
  /** Set only on a typed page; an older server and an untyped page omit both. */
  type?: 'decision' | 'approval' | 'review' | 'study'
  mode?: 'decide' | 'collect'
}

/** A review or study collects each person's answer and closes as done without an approval. */
export function isArtifactCollectAsk(review: ArtifactReviewInfo | null | undefined): boolean {
  return review?.type === 'review' || review?.type === 'study'
}

/** Who has answered a review or study; null on a decide ask, absent from an older server. */
export type ArtifactReviewProgress = {
  /** `<slug>:<revision>`; one "responses in" per id. */
  id: string
  revision: number
  submitted: number
  /** Named people; null on an everyone ask that names nobody. */
  of: number | null
  setAside: number
  everyone: boolean
  ready: boolean
  readyAt: string | null
  reason: 'all' | 'due' | null
  overdue: boolean
  people: { email: string; name: string; status: string; at: string | null }[]
}

export type ArtifactReviewDecision = {
  id: string
  revision: number
  decision: 'approved' | 'changes_requested' | 'rejected'
  comment: string
  edits: unknown
  by: { email: string; name: string }
  at: string
  /** An approval or change request OmniOS delivers to the asking session itself; older servers omit it. */
  deliveryKey?: string | null
}

/** Where the current decision's delivery is (OmniOS `answer_delivery`); only what a desktop reads. */
export type ArtifactReviewDelivery = {
  key: string
  state: string
  step?: string | null
  heldReason?: string | null
}

export type ArtifactReviewStatus = {
  artifact: ArtifactMetadata
  shareUrl: string
  status: string | null
  latest: ArtifactReviewDecision | null
  decisions: ArtifactReviewDecision[]
  viewer: { signedIn: boolean; isOwner: boolean; canDecide: boolean; retired?: boolean }
  /** Per-viewer pending attention, including retirement; omitted by older servers. */
  needsYou?: boolean
  progress?: ArtifactReviewProgress | null
  /** An open study's viewer who hasn't answered yet reads nobody else's answers; older servers omit it. */
  blind?: boolean
  /** The current approval's or change request's delivery; null when none, omitted by older servers. */
  delivery?: ArtifactReviewDelivery | null
} & ArtifactLifecycleFields

/** A local file identity (`sourceKey`), a raw artifact slug, or both; a share record wins. */
export type ArtifactReviewStatusRequest = ArtifactCloudOptions & {
  sourceKey?: string
  slug?: string
}

/** Withdraws the owner's own pending review (e.g. its question was answered elsewhere). */
export type ArtifactReviewCloseRequest = ArtifactReviewStatusRequest & { reason?: string }

/**
 * Closure state of a page (omni-console P0 lifecycle). A new server always emits these on the
 * artifact metadata, `null` when unset; an older server omits them.
 */
export const ARTIFACT_LIFECYCLES = ['done', 'no_action'] as const
export type ArtifactLifecycle = (typeof ARTIFACT_LIFECYCLES)[number]

export type ArtifactLifecycleFields = {
  lifecycle?: ArtifactLifecycle | null
  /** Set with `lifecycle`; the undo token `reopen` sends back. */
  closedAt?: string | null
  /** Where the result is; only meaningful with `done`. */
  closedRef?: string | null
  /** Successor page slug; independent of `lifecycle`. */
  supersededBy?: string | null
  /** Set with `supersededBy`; the undo token `unsupersede` sends back. */
  supersededAt?: string | null
}

/** A page id, or an omnios page link such as `https://app.omnisi.ai/a/<id>`; null otherwise. */
export function artifactSlugFromReference(reference: string): string | null {
  const text = reference.trim()
  if (ARTIFACT_SLUG_PATTERN.test(text)) {
    return text
  }
  let segments: string[] = []
  try {
    const url = new URL(text)
    segments = url.protocol === 'https:' ? url.pathname.split('/').filter(Boolean) : []
  } catch {
    segments = []
  }
  const pageIndex = segments.indexOf('a')
  const slug = pageIndex === -1 ? segments.at(-1) : segments[pageIndex + 1]
  return slug && ARTIFACT_SLUG_PATTERN.test(slug) ? slug : null
}

export type ArtifactLifecycleSnapshot = {
  revision: number | null
  lifecycle: ArtifactLifecycle | null
  closedAt: string | null
  closedRef: string | null
  supersededBy: string | null
  supersededAt: string | null
}

/** Reads the lifecycle from the status document's artifact, falling back to top-level fields. */
export function artifactLifecycleSnapshot(status: ArtifactReviewStatus): ArtifactLifecycleSnapshot {
  const artifact: ArtifactLifecycleFields = status.artifact ?? {}
  return {
    revision: status.artifact?.revision ?? null,
    lifecycle: artifact.lifecycle ?? status.lifecycle ?? null,
    closedAt: artifact.closedAt ?? status.closedAt ?? null,
    closedRef: artifact.closedRef ?? status.closedRef ?? null,
    supersededBy: artifact.supersededBy ?? status.supersededBy ?? null,
    supersededAt: artifact.supersededAt ?? status.supersededAt ?? null
  }
}

export const ARTIFACT_LIFECYCLE_ACTIONS = ['close', 'supersede', 'reopen', 'unsupersede'] as const
export type ArtifactLifecycleAction = (typeof ARTIFACT_LIFECYCLE_ACTIONS)[number]
export const ARTIFACT_LIFECYCLE_NOTE_MAX_CHARS = 500
export const ARTIFACT_LIFECYCLE_REF_MAX_CHARS = 512

const lifecycleRevision = z.number().int().min(0)
// Why opaque: the server compares the undo token to its row exactly; never reformat it.
const lifecycleToken = z.string().min(1).max(64)
const lifecycleSlug = z.string().regex(ARTIFACT_SLUG_PATTERN)

export const artifactLifecycleRefSchema = z
  .string()
  .max(ARTIFACT_LIFECYCLE_REF_MAX_CHARS)
  .refine(isCredentialFreeHttpsUrl, 'Expected an HTTPS URL without credentials')

/** Body of `POST /v1/artifacts/{slug}/lifecycle`; every action is fenced by `revision`. */
export const artifactLifecycleRequestSchema = z
  .discriminatedUnion('action', [
    z
      .object({
        action: z.literal('close'),
        revision: lifecycleRevision,
        lifecycle: z.enum(ARTIFACT_LIFECYCLES),
        note: z.string().max(ARTIFACT_LIFECYCLE_NOTE_MAX_CHARS).optional(),
        ref: artifactLifecycleRefSchema.optional(),
        expect: z.literal('open').optional()
      })
      .strict(),
    z
      .object({
        action: z.literal('supersede'),
        revision: lifecycleRevision,
        by: lifecycleSlug,
        expect: z.literal('unsuperseded').optional()
      })
      .strict(),
    z
      .object({
        action: z.literal('reopen'),
        revision: lifecycleRevision,
        closedAt: lifecycleToken
      })
      .strict(),
    z
      .object({
        action: z.literal('unsupersede'),
        revision: lifecycleRevision,
        by: lifecycleSlug,
        supersededAt: lifecycleToken
      })
      .strict()
  ])
  .refine((request) => request.action !== 'close' || !request.ref || request.lifecycle === 'done', {
    message: 'A result link belongs only to a page closed as done.',
    path: ['ref']
  })

export type ArtifactLifecycleRequest = z.infer<typeof artifactLifecycleRequestSchema>
