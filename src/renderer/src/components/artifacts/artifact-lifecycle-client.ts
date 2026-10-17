import type {
  ArtifactCloudOperation,
  ArtifactListItem,
  ArtifactListPage
} from '../../../../shared/artifacts'
import {
  artifactLifecycleSnapshot,
  isArtifactReviewResolved,
  type ArtifactLifecycleRequest,
  type ArtifactReviewStatus
} from '../../../../shared/artifact-review'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  artifactLifecycleErrorCode,
  artifactLifecycleErrorWords
} from './artifact-lifecycle-actions'

const LOCAL_RUNTIME = { kind: 'local' } as const

export type ArtifactLifecycleResult =
  | { ok: true; status: ArtifactReviewStatus }
  | { ok: false; code: string | null; words: string }

/** One `artifacts.lifecycle` call; failures come back as the server code and its words. */
export async function changeArtifactLifecycle(
  slug: string,
  body: ArtifactLifecycleRequest
): Promise<ArtifactLifecycleResult> {
  try {
    const result = await callRuntimeRpc<ArtifactCloudOperation<ArtifactReviewStatus>>(
      LOCAL_RUNTIME,
      'artifacts.lifecycle',
      { id: slug, body }
    )
    if (result.status === 'ok') {
      return { ok: true, status: result.value }
    }
    return {
      ok: false,
      code: null,
      words:
        result.status === 'unconfigured'
          ? result.message
          : translate(
              'auto.components.artifacts.ArtifactsPage.signInAgain',
              'Sign in to OmniConsole again to load artifacts.'
            )
    }
  } catch (error) {
    const code = artifactLifecycleErrorCode(error)
    return { ok: false, code, words: artifactLifecycleErrorWords(code) }
  }
}

/** The list row as the status document now describes it. */
export function applyArtifactReviewStatus(
  item: ArtifactListItem,
  status: ArtifactReviewStatus
): ArtifactListItem {
  const snapshot = artifactLifecycleSnapshot(status)
  const artifact = {
    ...item.artifact,
    ...status.artifact,
    lifecycle: snapshot.lifecycle,
    closedAt: snapshot.closedAt,
    closedRef: snapshot.closedRef,
    supersededBy: snapshot.supersededBy,
    supersededAt: snapshot.supersededAt
  }
  const closed =
    Boolean(artifact.lifecycle) ||
    Boolean(artifact.supersededBy) ||
    isArtifactReviewResolved(status.status)
  return {
    ...item,
    artifact,
    shareUrl: status.shareUrl || item.shareUrl,
    ...(status.needsYou !== undefined
      ? { needsYou: status.needsYou }
      : item.needsYou !== undefined
        ? { needsYou: item.needsYou && !closed }
        : {})
  }
}

const ATTENTION_MAX_PAGES = 5

export type ArtifactAttention = Pick<ArtifactListItem, 'needsYou' | 'lastDecision'>

/**
 * The viewer's own state for one page (needs you, last decision), which the status document does
 * not carry: read from the server's Needs me list. Absent from a fully read list means it does not
 * need the viewer; null when the answer is unknown (read failed or the list is longer than read).
 */
export async function fetchArtifactAttention(slug: string): Promise<ArtifactAttention | null> {
  let cursor: string | undefined
  try {
    for (let page = 0; page < ATTENTION_MAX_PAGES; page += 1) {
      const result = await callRuntimeRpc<ArtifactCloudOperation<ArtifactListPage>>(
        LOCAL_RUNTIME,
        'artifacts.list',
        cursor ? { state: 'needs_me', cursor } : { state: 'needs_me' }
      )
      if (result.status !== 'ok') {
        return null
      }
      const found = result.value.artifacts.find((item) => item.artifact.slug === slug)
      if (found) {
        return { needsYou: found.needsYou ?? true, lastDecision: found.lastDecision ?? null }
      }
      if (!result.value.nextCursor || result.value.nextCursor === cursor) {
        return { needsYou: false }
      }
      cursor = result.value.nextCursor
    }
  } catch {
    return null
  }
  return null
}
