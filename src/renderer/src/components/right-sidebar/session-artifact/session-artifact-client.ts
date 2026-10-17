import type { ArtifactCloudOperation } from '../../../../../shared/artifacts'
import type { ArtifactReviewStatus } from '../../../../../shared/artifact-review'
import type { ArtifactSessionRecord } from '../../../../../shared/artifact-session'
import type { SessionLinkedDocsEntry } from '../../../../../shared/session-linked-docs'
import type { SliteDocResult } from '../../../../../shared/slite-doc'
import {
  callRuntimeRpc,
  hasRuntimeRpcErrorCode,
  type RuntimeClientTarget
} from '@/runtime/runtime-rpc-client'

// Why local: share records and the signed-in credential both live with this desktop's main process.
const LOCAL_RUNTIME = { kind: 'local' } as const

/** This device's share records, without edit tokens, newest first. */
export async function listSessionArtifactRecords(): Promise<ArtifactSessionRecord[]> {
  const records = await callRuntimeRpc<ArtifactSessionRecord[] | null>(
    LOCAL_RUNTIME,
    'artifacts.sessionRecords',
    undefined
  )
  return Array.isArray(records) ? records : []
}

/**
 * The server's view of one artifact (title, revision, review state). Null when signed out, when
 * the server predates reviews, or on any failure: the preview still renders without it.
 */
export async function fetchSessionArtifactReview(
  slug: string
): Promise<ArtifactReviewStatus | null> {
  const result = await callRuntimeRpc<ArtifactCloudOperation<ArtifactReviewStatus>>(
    LOCAL_RUNTIME,
    'artifacts.reviewStatus',
    { slug }
  )
  return result.status === 'ok' ? result.value : null
}

/** The Slite docs and omnios pages each conversation linked in its replies. A local read. */
export async function listSessionLinkedDocs(): Promise<SessionLinkedDocsEntry[]> {
  const entries = await callRuntimeRpc<SessionLinkedDocsEntry[] | null>(
    LOCAL_RUNTIME,
    'artifacts.sessionLinkedDocs',
    undefined
  )
  return Array.isArray(entries) ? entries : []
}

/** One Slite doc as Markdown, read by the main process with the person's own Slite key. */
export async function fetchSliteDoc(id: string): Promise<SliteDocResult> {
  return callRuntimeRpc<SliteDocResult>(LOCAL_RUNTIME, 'artifacts.sliteDoc', { id })
}

const stringPaths = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((path): path is string => typeof path === 'string') : []

/** From a first-release host's by-pane records, only those that name this very session. */
function firstReleaseSessionPaths(records: unknown, sessionId: string): string[] {
  const paths = (Array.isArray(records) ? records : []).flatMap((record: unknown) => {
    const entry = record as { sessionId?: unknown; paths?: unknown } | null
    return entry?.sessionId === sessionId ? stringPaths(entry.paths) : []
  })
  return paths.filter((path, index) => paths.lastIndexOf(path) === index)
}

/**
 * The files one provider session's write tools finished writing, as the main process of the host
 * that ran it recorded them from every hook event. Empty when that host predates the record.
 */
export async function listSessionWrittenFiles(
  target: RuntimeClientTarget,
  session: { provider: string; sessionId: string }
): Promise<string[]> {
  try {
    return stringPaths(
      await callRuntimeRpc<unknown>(target, 'artifacts.sessionWrittenFilesV2', session)
    )
  } catch (error) {
    if (!hasRuntimeRpcErrorCode(error, 'method_not_found')) {
      return []
    }
  }
  // Why: a host from before per-session reads still answers the first release's by-pane list.
  try {
    const records = await callRuntimeRpc<unknown>(
      target,
      'artifacts.sessionWrittenFiles',
      undefined
    )
    return firstReleaseSessionPaths(records, session.sessionId)
  } catch {
    return []
  }
}
