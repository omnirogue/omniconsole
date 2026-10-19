import { basename, extname, resolve } from 'node:path'
import type {
  ArtifactCloudOperation,
  ArtifactListPage,
  ArtifactListItem,
  ArtifactWriteRequest
} from '../../shared/artifacts'
import { ARTIFACT_CLI_MAX_RPC_BYTES } from '../../shared/artifacts'
import {
  parseRemoteArtifactInput,
  REMOTE_ARTIFACT_INPUT_ENV
} from '../../shared/artifact-cli-bridge'
import { readArtifactFileWithinLimit } from '../../shared/artifact-file-read'
import {
  ARTIFACT_SHARING_DISABLED_CODE,
  ARTIFACT_SHARING_DISABLED_MESSAGE,
  ARTIFACT_SHARING_DISABLED_NEXT_STEPS
} from '../../shared/artifact-sharing-gate'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { RuntimeClientError } from '../runtime-client'
import {
  cloudOptions,
  rejectRemoteSelectionFlags,
  requireOperation,
  requireStringFlag,
  stringFlag
} from '../artifact-cli-options'
import {
  formatArtifactListPage,
  formatArtifactReviewStatus,
  formatArtifactShared
} from '../artifact-format'
import { parseArtifactReviewFlags } from '../artifact-review-flags'
import {
  artifactReviewWaitStatus,
  artifactStatusRequestTarget,
  parseArtifactStatusInvocation,
  pollArtifactReviewStatus
} from '../artifact-review-status'
import type { ArtifactReviewStatus } from '../../shared/artifact-review'
import type { ArtifactWriteOrigin } from '../../shared/artifact-session'
import { printResult } from '../format'

/**
 * The IDE injects these into every terminal it manages. Passing them lets the desktop tie the
 * artifact to the session that published it; the main process re-resolves the handle itself.
 */
function artifactWriteOrigin(): ArtifactWriteOrigin | undefined {
  const origin: ArtifactWriteOrigin = {}
  const terminalHandle = process.env.ORCA_TERMINAL_HANDLE?.trim()
  const paneKey = process.env.ORCA_PANE_KEY?.trim()
  const worktreeId = process.env.ORCA_WORKTREE_ID?.trim()
  if (terminalHandle) {
    origin.terminalHandle = terminalHandle
  }
  if (paneKey) {
    origin.paneKey = paneKey
  }
  if (worktreeId) {
    origin.worktreeId = worktreeId
  }
  if (Object.keys(origin).length === 0) {
    return undefined
  }
  const claudeSessionId = process.env.CLAUDE_CODE_SESSION_ID?.trim()
  return claudeSessionId ? { ...origin, claudeSessionId } : origin
}

function artifactContentType(path: string): ArtifactWriteRequest['contentType'] | null {
  const extension = extname(path).toLowerCase()
  return ['.html', '.htm'].includes(extension)
    ? 'text/html'
    : ['.md', '.markdown'].includes(extension)
      ? 'text/markdown'
      : null
}

async function readStdinWithinLimit(maxBytes: number): Promise<string> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    bytes += buffer.length
    if (bytes > maxBytes) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Artifact is too large for the OmniConsole CLI transport. Use the browser upload page instead.'
      )
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Publishing is off by default, so denial is the common outcome. A tiny `settings.get` read
 * answers it before we load (or pipe in) up to the full RPC byte budget the host would reject.
 * Only an explicit `false` denies: a host predating the capability omits the field entirely,
 * and an unreachable host stays the publish RPC's problem, not the preflight's.
 */
async function preflightPublishCapability(ctx: HandlerContext): Promise<void> {
  let enabled: unknown
  try {
    const response = await ctx.client.call<{
      settings?: { artifactSharingEnabled?: boolean }
    }>('settings.get')
    enabled = response.result?.settings?.artifactSharingEnabled
  } catch {
    return
  }
  if (enabled === false) {
    throw new RuntimeClientError(
      ARTIFACT_SHARING_DISABLED_CODE,
      ARTIFACT_SHARING_DISABLED_MESSAGE,
      { nextSteps: [...ARTIFACT_SHARING_DISABLED_NEXT_STEPS] }
    )
  }
}

async function readArtifactRequest(
  ctx: HandlerContext
): Promise<ArtifactWriteRequest & { keepSession?: true }> {
  // Why first: a bad review flag should fail before the capability preflight or file read.
  const reviewFields = parseArtifactReviewFlags(ctx.flags)
  const remoteInput = parseRemoteArtifactInput(process.env[REMOTE_ARTIFACT_INPUT_ENV])
  const sourceKey = remoteInput?.sourceKey ?? resolve(ctx.cwd, requireStringFlag(ctx, 'file'))
  const contentType = remoteInput?.contentType ?? artifactContentType(sourceKey)
  if (!contentType) {
    throw new RuntimeClientError('invalid_argument', 'Artifacts must be HTML or Markdown files.')
  }
  await preflightPublishCapability(ctx)
  const localRead = remoteInput
    ? null
    : await readArtifactFileWithinLimit(sourceKey, ARTIFACT_CLI_MAX_RPC_BYTES)
  if (localRead?.status === 'not-file') {
    throw new RuntimeClientError(
      'invalid_argument',
      'Artifact file was not found or is not a file.'
    )
  }
  if (localRead?.status === 'too-large') {
    throw new RuntimeClientError(
      'invalid_argument',
      'Artifact is too large for the OmniConsole CLI transport. Use the browser upload page instead.'
    )
  }
  const content = remoteInput
    ? await readStdinWithinLimit(ARTIFACT_CLI_MAX_RPC_BYTES)
    : localRead?.status === 'ok'
      ? localRead.content
      : ''
  if (!content) {
    throw new RuntimeClientError('invalid_argument', 'Artifact file is empty.')
  }
  const origin = artifactWriteOrigin()
  const request: ArtifactWriteRequest & { keepSession?: true } = {
    sourceKey,
    content,
    contentType,
    fileName: remoteInput?.fileName ?? basename(sourceKey),
    ...reviewFields,
    ...(origin ? { origin } : {}),
    ...(ctx.flags.get('keep-session') === true ? { keepSession: true } : {}),
    ...cloudOptions(ctx)
  }
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > ARTIFACT_CLI_MAX_RPC_BYTES) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Artifact is too large for the OmniConsole CLI transport. Use the browser upload page instead.'
    )
  }
  return request
}

export const ARTIFACT_HANDLERS: Record<string, CommandHandler> = {
  'artifacts list': async (ctx) => {
    rejectRemoteSelectionFlags(ctx)
    const cursor = stringFlag(ctx, 'cursor')
    const response = await ctx.client.call<ArtifactCloudOperation<ArtifactListPage>>(
      'artifacts.list',
      {
        ...cloudOptions(ctx),
        ...(cursor ? { cursor } : {})
      }
    )
    const value = requireOperation(response.result)
    printResult({ ...response, result: value }, ctx.json, formatArtifactListPage)
  },
  'artifacts share': async (ctx) => {
    rejectRemoteSelectionFlags(ctx)
    const response = await ctx.client.call<ArtifactCloudOperation<ArtifactListItem>>(
      'artifacts.share',
      await readArtifactRequest(ctx)
    )
    const value = requireOperation(response.result)
    printResult({ ...response, result: value }, ctx.json, formatArtifactShared)
  },
  'artifacts update': async (ctx) => {
    rejectRemoteSelectionFlags(ctx)
    const response = await ctx.client.call<ArtifactCloudOperation<ArtifactListItem>>(
      'artifacts.update',
      await readArtifactRequest(ctx)
    )
    const value = requireOperation(response.result)
    printResult({ ...response, result: value }, ctx.json, formatArtifactShared)
  },
  'artifacts status': async (ctx) => {
    rejectRemoteSelectionFlags(ctx)
    const { target, waitSeconds } = parseArtifactStatusInvocation(ctx.flags)
    const remoteInput = parseRemoteArtifactInput(process.env[REMOTE_ARTIFACT_INPUT_ENV])
    const params = {
      ...artifactStatusRequestTarget(target, ctx.cwd, remoteInput?.sourceKey),
      ...cloudOptions(ctx)
    }
    const response = await pollArtifactReviewStatus(
      async () => {
        const next = await ctx.client.call<ArtifactCloudOperation<ArtifactReviewStatus>>(
          'artifacts.reviewStatus',
          params
        )
        return { ...next, result: requireOperation(next.result) }
      },
      (next) => artifactReviewWaitStatus(next.result),
      { waitSeconds }
    )
    printResult(response, ctx.json, formatArtifactReviewStatus)
  },
  'artifacts close-review': async (ctx) => {
    rejectRemoteSelectionFlags(ctx)
    const remoteInput = parseRemoteArtifactInput(process.env[REMOTE_ARTIFACT_INPUT_ENV])
    const reason = stringFlag(ctx, 'reason')
    const response = await ctx.client.call<ArtifactCloudOperation<ArtifactReviewStatus>>(
      'artifacts.closeReview',
      {
        ...artifactStatusRequestTarget(
          requireStringFlag(ctx, 'file'),
          ctx.cwd,
          remoteInput?.sourceKey
        ),
        ...(reason ? { reason } : {}),
        ...cloudOptions(ctx)
      }
    )
    const value = requireOperation(response.result)
    printResult({ ...response, result: value }, ctx.json, formatArtifactReviewStatus)
  },
  'artifacts unshare': async (ctx) => {
    rejectRemoteSelectionFlags(ctx)
    const remoteInput = parseRemoteArtifactInput(process.env[REMOTE_ARTIFACT_INPUT_ENV])
    const sourceKey = remoteInput?.sourceKey ?? resolve(ctx.cwd, requireStringFlag(ctx, 'file'))
    const response = await ctx.client.call<ArtifactCloudOperation<void>>('artifacts.unshare', {
      sourceKey,
      ...cloudOptions(ctx)
    })
    requireOperation(response.result)
    printResult({ ...response, result: { deleted: true } }, ctx.json, () => 'Artifact deleted.')
  },
  'artifacts delete': async (ctx) => {
    rejectRemoteSelectionFlags(ctx)
    const response = await ctx.client.call<ArtifactCloudOperation<void>>('artifacts.delete', {
      id: requireStringFlag(ctx, 'id'),
      ...cloudOptions(ctx)
    })
    requireOperation(response.result)
    printResult({ ...response, result: { deleted: true } }, ctx.json, () => 'Artifact deleted.')
  }
}
