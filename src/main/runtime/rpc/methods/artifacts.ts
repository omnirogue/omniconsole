import { z } from 'zod'
import { artifactProposalSchema } from '../../../../shared/artifact-proposal'
import {
  ARTIFACT_CLI_MAX_RPC_BYTES,
  ARTIFACT_LIST_STATES,
  artifactWriteRequestByteLength
} from '../../../../shared/artifacts'
import {
  ARTIFACT_AUDIENCES,
  artifactLifecycleRequestSchema,
  ARTIFACT_REVIEW_CATEGORY_MAX_CHARS,
  ARTIFACT_REVIEW_OPTION_DETAIL_MAX_CHARS,
  ARTIFACT_REVIEW_OPTION_LABEL_MAX_CHARS,
  ARTIFACT_REVIEW_OPTIONS_MAX,
  ARTIFACT_REVIEW_OPTIONS_MIN,
  ARTIFACT_REVIEW_QUESTION_MAX_CHARS,
  ARTIFACT_REVIEW_SUMMARY_MAX_CHARS,
  ARTIFACT_REVIEWERS_MAX,
  ARTIFACT_SLUG_PATTERN
} from '../../../../shared/artifact-review'
import { ARTIFACT_ORIGIN_FIELD_MAX_CHARS } from '../../../../shared/artifact-session'
import { SLITE_DOC_ID_PATTERN } from '../../../../shared/session-linked-docs'
import { withResolvedArtifactOrigin } from '../../../artifacts/artifact-session-origin'
import { withArtifactSessionSleep } from '../../../artifacts/artifact-review-sleep-arm'
import {
  listReviewSleepEntries,
  listReviewSleepTargets,
  noteReviewSessionAsleep
} from '../../../artifacts/artifact-review-sleep-targets'
import { getSessionLinkedDocsStore } from '../../../artifacts/session-linked-docs-store'
import { getSessionWrittenFilesStore } from '../../../artifacts/session-written-files-store'
import { readSliteDoc } from '../../../artifacts/slite-doc-reader'
import {
  searchContextDocuments,
  resolveContextDocument
} from '../../../artifacts/context-document-search'
import { SESSION_CONTEXT_DOCUMENT_QUERY_MAX_CHARS } from '../../../../shared/session-context-documents'
import { defineMethod, type RpcAnyMethod } from '../core'

const CloudOptions = {
  apiUrl: z.string().max(2_048).optional(),
  authToken: z.string().max(16_384).optional()
}

const ListOptions = z.object({
  ...CloudOptions,
  cursor: z.string().min(1).max(2_048).optional(),
  state: z.enum(ARTIFACT_LIST_STATES).optional()
})

const LifecycleRequest = z.object({
  id: z.string().regex(ARTIFACT_SLUG_PATTERN),
  body: artifactLifecycleRequestSchema,
  ...CloudOptions
})

const SourceRequest = z.object({
  sourceKey: z.string().min(1).max(32_768),
  ...CloudOptions
})

const ReviewOption = z
  .object({
    label: z.string().min(1).max(ARTIFACT_REVIEW_OPTION_LABEL_MAX_CHARS),
    detail: z.string().min(1).max(ARTIFACT_REVIEW_OPTION_DETAIL_MAX_CHARS).optional(),
    recommended: z.literal(true).optional()
  })
  .strict()

// Why: OmniOS (artifact_reviews.normalize_review) owns the cross-field rules; this bounds shape.
const ReviewRequest = z
  .object({
    question: z.string().min(1).max(ARTIFACT_REVIEW_QUESTION_MAX_CHARS).optional(),
    reviewers: z.array(z.string().min(1).max(320)).min(1).max(ARTIFACT_REVIEWERS_MAX).optional(),
    context: artifactProposalSchema.optional(),
    summary: z.string().min(1).max(ARTIFACT_REVIEW_SUMMARY_MAX_CHARS).optional(),
    options: z
      .array(ReviewOption)
      .min(ARTIFACT_REVIEW_OPTIONS_MIN)
      .max(ARTIFACT_REVIEW_OPTIONS_MAX)
      .optional(),
    multi: z.literal(true).optional(),
    about: z
      .object({ category: z.string().min(1).max(ARTIFACT_REVIEW_CATEGORY_MAX_CHARS) })
      .strict()
      .optional()
  })
  .strict()

const ReviewCloseRequest = z
  .object({
    sourceKey: z.string().min(1).max(32_768).optional(),
    slug: z.string().regex(ARTIFACT_SLUG_PATTERN).optional(),
    reason: z.string().max(500).optional(),
    ...CloudOptions
  })
  .refine((request) => request.sourceKey !== undefined || request.slug !== undefined, {
    message: 'Pass a shared file or an artifact id.'
  })

const ReviewStatusRequest = z
  .object({
    sourceKey: z.string().min(1).max(32_768).optional(),
    slug: z.string().regex(ARTIFACT_SLUG_PATTERN).optional(),
    ...CloudOptions
  })
  .refine((request) => request.sourceKey !== undefined || request.slug !== undefined, {
    message: 'Pass a shared file or an artifact id.'
  })

const OriginField = z.string().min(1).max(ARTIFACT_ORIGIN_FIELD_MAX_CHARS).optional()

// Why not strict: the CLI may report more terminal context later; an older desktop drops it.
const WriteOrigin = z.object({
  terminalHandle: OriginField,
  paneKey: OriginField,
  worktreeId: OriginField
})

const WriteRequest = z
  .object({
    sourceKey: z.string().min(1).max(32_768),
    content: z.string().min(1).max(ARTIFACT_CLI_MAX_RPC_BYTES),
    contentType: z.enum(['text/html', 'text/markdown']),
    fileName: z.string().min(1).max(512),
    title: z.string().max(512).optional(),
    review: ReviewRequest.optional(),
    audience: z.enum(ARTIFACT_AUDIENCES).optional(),
    origin: WriteOrigin.optional(),
    // Local only: the publishing session keeps running instead of sleeping for the decision.
    keepSession: z.boolean().optional(),
    ...CloudOptions
  })
  .refine((request) => artifactWriteRequestByteLength(request) <= ARTIFACT_CLI_MAX_RPC_BYTES, {
    message: 'Artifact request exceeds the local RPC size limit.'
  })

export const ARTIFACT_METHODS: readonly RpcAnyMethod[] = [
  defineMethod({
    name: 'artifacts.searchContextDocuments',
    params: z
      .object({
        source: z.enum(['slite', 'omnios']),
        query: z.string().max(SESSION_CONTEXT_DOCUMENT_QUERY_MAX_CHARS),
        cursor: z.string().min(1).max(2_048).optional()
      })
      .strict(),
    handler: (params, { runtime }) => searchContextDocuments(params, runtime)
  }),
  defineMethod({
    name: 'artifacts.resolveContextDocument',
    params: z
      .object({ source: z.enum(['slite', 'omnios']), id: z.string().min(1).max(128) })
      .strict(),
    handler: (params, { runtime }) => resolveContextDocument(params, runtime)
  }),
  defineMethod({
    name: 'artifacts.list',
    params: ListOptions,
    handler: (params, { runtime }) => runtime.listArtifacts(params)
  }),
  defineMethod({
    name: 'artifacts.getPublishedLink',
    params: SourceRequest,
    handler: (params, { runtime }) => runtime.getPublishedArtifactLink(params)
  }),
  defineMethod({
    name: 'artifacts.share',
    params: WriteRequest,
    handler: async (params, { runtime }) => {
      const request = withResolvedArtifactOrigin(runtime, params)
      return withArtifactSessionSleep(runtime, request, await runtime.shareArtifact(request))
    }
  }),
  defineMethod({
    name: 'artifacts.publish',
    params: WriteRequest,
    handler: async (params, { runtime }) => {
      const request = withResolvedArtifactOrigin(runtime, params)
      return withArtifactSessionSleep(runtime, request, await runtime.publishArtifact(request))
    }
  }),
  defineMethod({
    name: 'artifacts.update',
    params: WriteRequest,
    handler: async (params, { runtime }) => {
      const request = withResolvedArtifactOrigin(runtime, params)
      return withArtifactSessionSleep(runtime, request, await runtime.updateArtifact(request))
    }
  }),
  defineMethod({
    name: 'artifacts.reviewStatus',
    params: ReviewStatusRequest,
    handler: (params, { runtime }) => runtime.getArtifactReviewStatus(params)
  }),
  defineMethod({
    name: 'artifacts.closeReview',
    params: ReviewCloseRequest,
    handler: (params, { runtime }) => runtime.closeArtifactReview(params)
  }),
  defineMethod({
    name: 'artifacts.lifecycle',
    params: LifecycleRequest,
    handler: ({ id, body, ...options }, { runtime }) =>
      runtime.changeArtifactLifecycle(id, body, options)
  }),
  defineMethod({
    name: 'artifacts.reviewSleepTargets',
    params: null,
    handler: (_params, { runtime }) =>
      listReviewSleepTargets(
        runtime.getHeadlessSleepSettings(),
        listReviewSleepEntries(runtime.getArtifactApiOrigin())
      )
  }),
  defineMethod({
    name: 'artifacts.reviewWaits',
    params: null,
    handler: (_params, { runtime }) => runtime.listArtifactReviewWaits()
  }),
  defineMethod({
    name: 'artifacts.reviewSleepNoted',
    params: z
      .object({ paneKey: z.string().min(1).max(4_096), worktreeId: z.string().min(1).max(4_096) })
      .strict(),
    // Why only waiting → asleep: a stray call at most lets the next decision resume a parked pane.
    handler: (params, { runtime }) => ({
      noted: noteReviewSessionAsleep(params, runtime.getArtifactApiOrigin())
    })
  }),
  defineMethod({
    name: 'artifacts.sessionRecords',
    params: null,
    handler: (_params, { runtime }) => runtime.listArtifactSessionRecords()
  }),
  defineMethod({
    name: 'artifacts.sessionLinkedDocs',
    params: null,
    handler: (_params, { runtime }) => {
      // Without an origin omnios pages cannot be previewed; Slite docs still show.
      const apiOrigin = runtime.getArtifactApiOrigin() ?? ''
      return (getSessionLinkedDocsStore()?.list() ?? []).map((entry) => ({ ...entry, apiOrigin }))
    }
  }),
  defineMethod({
    name: 'artifacts.sessionWrittenFiles',
    params: null,
    // Why kept as published: clients from before per-session reads find their records by pane.
    handler: () => getSessionWrittenFilesStore()?.listByPane() ?? []
  }),
  defineMethod({
    name: 'artifacts.sessionWrittenFilesV2',
    params: z.object({
      provider: z.string().min(1).max(512),
      sessionId: z.string().min(1).max(512)
    }),
    handler: (params) =>
      getSessionWrittenFilesStore()?.pathsFor(params.provider, params.sessionId) ?? []
  }),
  defineMethod({
    name: 'artifacts.sliteDoc',
    params: z.object({ id: z.string().regex(SLITE_DOC_ID_PATTERN) }).strict(),
    handler: (params) => readSliteDoc(params.id)
  }),
  defineMethod({
    name: 'artifacts.unshare',
    params: SourceRequest,
    handler: (params, { runtime }) => runtime.unshareArtifact(params)
  }),
  defineMethod({
    name: 'artifacts.delete',
    params: z.object({ id: z.string().min(1), ...CloudOptions }),
    handler: (params, { runtime }) => runtime.deleteArtifact(params.id, params)
  })
]
