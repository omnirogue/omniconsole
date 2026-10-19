import {
  ARTIFACT_LIFECYCLE_NOTE_MAX_CHARS,
  artifactLifecycleRefSchema,
  artifactSlugFromReference as slugFromReference,
  artifactLifecycleSnapshot,
  type ArtifactLifecycleRequest,
  type ArtifactLifecycleSnapshot,
  type ArtifactReviewStatus
} from '../../shared/artifact-review'
import type { ArtifactCloudOperation } from '../../shared/artifacts'
import {
  parseRemoteArtifactInput,
  REMOTE_ARTIFACT_INPUT_ENV
} from '../../shared/artifact-cli-bridge'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { RuntimeClientError } from '../runtime-client'
import {
  cloudOptions,
  rejectRemoteSelectionFlags,
  requireOperation,
  requireStringFlag,
  stringFlag
} from '../artifact-cli-options'
import { artifactMutationRequestTarget, isSshArtifactCaller } from '../artifact-review-status'
import { formatArtifactReviewStatus } from '../artifact-format'
import { printResult } from '../format'

type LifecycleBody = (
  slug: string,
  current: ArtifactLifecycleSnapshot & { revision: number }
) => ArtifactLifecycleRequest

function invalid(message: string): RuntimeClientError {
  return new RuntimeClientError('invalid_argument', message)
}

/** A page id, or an omnios page link such as `https://app.omnisi.ai/a/<id>`. */
export function artifactSlugFromReference(reference: string): string {
  const slug = slugFromReference(reference)
  if (!slug) {
    throw invalid('--by takes a page id or an https link to the page.')
  }
  return slug
}

function expectedRevision(ctx: HandlerContext): number | undefined {
  const text = stringFlag(ctx, 'revision')
  const revision = text ? Number(text) : undefined
  if (
    ctx.flags.has('revision') &&
    (!text || !/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(revision))
  ) {
    throw invalid('--revision must be a positive integer.')
  }
  return revision
}

function parseCloseBody(ctx: HandlerContext): LifecycleBody {
  const done = ctx.flags.has('done')
  if (done === ctx.flags.has('no-action')) {
    throw invalid('Pass exactly one of --done or --no-action.')
  }
  const ref = stringFlag(ctx, 'ref')
  if (ref && !done) {
    throw invalid('--ref names where the result is; it goes only with --done.')
  }
  if (ref && !artifactLifecycleRefSchema.safeParse(ref).success) {
    throw invalid('--ref must be an https link without credentials (max 512 characters).')
  }
  const note = stringFlag(ctx, 'note')
  if (note && note.length > ARTIFACT_LIFECYCLE_NOTE_MAX_CHARS) {
    throw invalid(`--note must be at most ${ARTIFACT_LIFECYCLE_NOTE_MAX_CHARS} characters.`)
  }
  const revision = expectedRevision(ctx)
  return (_slug, current) => ({
    action: 'close',
    // A human answered this revision; a later read must never retarget that answer.
    revision: revision ?? current.revision,
    lifecycle: done ? 'done' : 'no_action',
    ...(ctx.flags.has('expect-open') ? { expect: 'open' as const } : {}),
    ...(note ? { note } : {}),
    ...(ref ? { ref } : {})
  })
}

function parseSupersedeBody(ctx: HandlerContext): LifecycleBody {
  const by = artifactSlugFromReference(requireStringFlag(ctx, 'by'))
  const revision = expectedRevision(ctx)
  return (slug, current) => {
    if (by === slug) {
      throw invalid('A page cannot supersede itself.')
    }
    return {
      action: 'supersede',
      revision: revision ?? current.revision,
      by,
      ...(ctx.flags.has('expect-unsuperseded') ? { expect: 'unsuperseded' as const } : {})
    }
  }
}

const reopenBody: LifecycleBody = (slug, current) => {
  if (!current.closedAt) {
    throw invalid(`Artifact ${slug} is not closed.`)
  }
  return { action: 'reopen', revision: current.revision, closedAt: current.closedAt }
}

const unsupersedeBody: LifecycleBody = (slug, current) => {
  if (!current.supersededBy || !current.supersededAt) {
    throw invalid(`Artifact ${slug} has no successor.`)
  }
  return {
    action: 'unsupersede',
    revision: current.revision,
    by: current.supersededBy,
    supersededAt: current.supersededAt
  }
}

/** Reads the page first: every change is fenced by its revision and undo tokens. */
async function changeLifecycle(ctx: HandlerContext, bodyFor: LifecycleBody): Promise<void> {
  const remoteInput = parseRemoteArtifactInput(process.env[REMOTE_ARTIFACT_INPUT_ENV])
  const options = cloudOptions(ctx)
  const read = await ctx.client.call<ArtifactCloudOperation<ArtifactReviewStatus>>(
    'artifacts.reviewStatus',
    {
      ...artifactMutationRequestTarget(
        requireStringFlag(ctx, 'file'),
        ctx.cwd,
        remoteInput?.sourceKey,
        isSshArtifactCaller()
      ),
      ...options
    }
  )
  const current = requireOperation(read.result)
  const snapshot = artifactLifecycleSnapshot(current)
  const slug = current.artifact?.slug
  if (!slug || snapshot.revision === null) {
    throw new RuntimeClientError(
      'artifact_lifecycle_unsupported',
      'This OmniConsole server does not report the page revision, so it cannot change lifecycle yet.'
    )
  }
  const response = await ctx.client.call<ArtifactCloudOperation<ArtifactReviewStatus>>(
    'artifacts.lifecycle',
    { id: slug, body: bodyFor(slug, { ...snapshot, revision: snapshot.revision }), ...options }
  )
  const value = requireOperation(response.result)
  printResult({ ...response, result: value }, ctx.json, formatArtifactReviewStatus)
}

function lifecycleHandler(parse: (ctx: HandlerContext) => LifecycleBody): CommandHandler {
  return async (ctx) => {
    rejectRemoteSelectionFlags(ctx)
    // Why before any read: a bad flag should fail without contacting the server.
    await changeLifecycle(ctx, parse(ctx))
  }
}

export const ARTIFACT_LIFECYCLE_HANDLERS: Record<string, CommandHandler> = {
  'artifacts close': lifecycleHandler(parseCloseBody),
  'artifacts supersede': lifecycleHandler(parseSupersedeBody),
  'artifacts reopen': lifecycleHandler(() => reopenBody),
  'artifacts unsupersede': lifecycleHandler(() => unsupersedeBody)
}
