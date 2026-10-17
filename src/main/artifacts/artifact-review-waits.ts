import type {
  ReviewWaitItem,
  ReviewWaitSession,
  ReviewWaitsResult
} from '../../shared/artifact-review-waits'
import type { ArtifactCloudService } from './artifact-cloud-service'
import { isArtifactReviewResolved } from '../../shared/artifact-review'
import { artifactApiRequest } from './artifact-cloud-request'
import { listReviewSleepEntries, type ReviewSleepEntry } from './artifact-review-sleep-targets'
import { publicSourceReason, reviewHostLabel } from './artifact-source-state-report'
import {
  reconcileReviewAttention,
  validArtifactReviewAttention,
  type ArtifactReviewAttention
} from './artifact-review-attention'
import { activeArtifactShareScope } from './artifact-share-scope'
import { updateArtifactShareRecord } from './artifact-share-record-store'

type InboxItem = {
  slug: string
  title?: string | null
  question?: string
  summary?: string | null
  shareUrl?: string
  status?: string
  revision?: number
  updatedAt?: string | null
  publishedBy?: { name?: string; email?: string; isYou?: boolean }
  sourceState?: {
    state?: string
    revision?: number | null
    host?: string | null
    hostOnline?: boolean | null
    at?: string | null
    portable?: boolean | null
    reason?: string | null
  } | null
}

/** Session continuation state is only a fallback when canonical attention cannot be read. */
const OPEN_WAITS = new Set(['waiting', 'asleep', 'waking', 'stalled'])

function localSession(entry: ReviewSleepEntry, host: string): ReviewWaitSession {
  return {
    state: entry.sleep.state,
    host: entry.sleep.state === 'moved' ? (entry.sleep.movedTo?.host ?? null) : host,
    at: new Date(entry.sleep.at).toISOString(),
    reason: publicSourceReason(entry.sleep) ?? null,
    detail: entry.sleep.reason ?? null,
    local: true,
    ledgerId: entry.sourceReview.ledgerId,
    paneKey: entry.sourceReview.paneKey,
    nativeSessionId: entry.sourceReview.nativeSessionId
  }
}

function remoteSession(item: InboxItem): ReviewWaitSession | null {
  const state = item.sourceState?.state
  const revision = item.sourceState?.revision
  // As OmniOS's currentSource: a report about another revision says nothing about this one.
  return state && (typeof revision !== 'number' || revision === (item.revision ?? 1))
    ? {
        state,
        host: item.sourceState?.host ?? null,
        hostOnline: item.sourceState?.hostOnline ?? null,
        at: item.sourceState?.at ?? null,
        portable: item.sourceState?.portable ?? null,
        reason: item.sourceState?.reason ?? null,
        local: false
      }
    : null
}

export function mergeReviewWaits(
  inbox: readonly InboxItem[],
  entries: readonly ReviewSleepEntry[],
  host: string,
  freshAttention: ReadonlyMap<string, ArtifactReviewAttention> = new Map()
): ReviewWaitItem[] {
  // Why one per slug, the latest revision then the newest state: two share records of one page
  // would list it twice.
  const local = new Map<string, ReviewSleepEntry>()
  const observations = new Map<string, ArtifactReviewAttention>()
  for (const entry of entries) {
    const attention = entry.reviewAttention
    const previous = observations.get(entry.slug)
    if (
      attention &&
      (!previous ||
        attention.revision > previous.revision ||
        (attention.revision === previous.revision && attention.observedAt > previous.observedAt))
    ) {
      observations.set(entry.slug, attention)
    }
    const seen = local.get(entry.slug)
    const later =
      !seen ||
      entry.sleep.revision > seen.sleep.revision ||
      (entry.sleep.revision === seen.sleep.revision && entry.sleep.at > seen.sleep.at)
    if (later) {
      local.set(entry.slug, entry)
    }
  }
  const latestInbox = new Map<string, InboxItem>()
  for (const item of inbox) {
    const previous = latestInbox.get(item.slug)
    if (!previous || (item.revision ?? 1) >= (previous.revision ?? 1)) {
      latestInbox.set(item.slug, item)
    }
  }
  const items: ReviewWaitItem[] = [...latestInbox.values()].flatMap((item) => {
    const own = local.get(item.slug)
    const attention = observations.get(item.slug)
    const fresh = freshAttention.get(item.slug)
    // A Restore can make the inbox positive again; only a later detail read can override it.
    if (
      isArtifactReviewResolved(item.status) ||
      (attention && attention.revision > (item.revision ?? 1)) ||
      (fresh && fresh.revision === (item.revision ?? 1) && !fresh.needsYou)
    ) {
      return []
    }
    // Why: a wait about an earlier revision says nothing about the revision now waiting.
    const entry = own && own.sleep.revision === (item.revision ?? 1) ? own : undefined
    return [
      {
        slug: item.slug,
        title: item.title || item.slug,
        question: item.question ?? '',
        summary: item.summary?.trim() || null,
        shareUrl: item.shareUrl ?? '',
        status: item.status ?? 'pending',
        revision: item.revision ?? 1,
        updatedAt: item.updatedAt ?? null,
        publishedBy: item.publishedBy
          ? {
              name: item.publishedBy.name ?? '',
              email: item.publishedBy.email ?? '',
              isYou: item.publishedBy.isYou === true
            }
          : null,
        // Why local first: this computer's own record is fresher than what it last reported.
        session: entry ? localSession(entry, host) : remoteSession(item)
      }
    ]
  })
  const listed = new Set(items.map((item) => item.slug))
  for (const entry of local.values()) {
    if (!listed.has(entry.slug) && OPEN_WAITS.has(entry.sleep.state)) {
      const attention = observations.get(entry.slug)
      const current = attention && attention.revision >= entry.sleep.revision ? attention : null
      if (current && !current.needsYou) {
        continue
      }
      const revision = current?.revision ?? entry.sleep.revision
      const listedReview = latestInbox.get(entry.slug)
      if (
        isArtifactReviewResolved(listedReview?.status) &&
        (listedReview?.revision ?? 1) >= revision &&
        !(current?.needsYou && current.revision >= (listedReview?.revision ?? 1))
      ) {
        continue
      }
      items.push({
        slug: entry.slug,
        title: entry.title ?? entry.slug,
        question: '',
        summary: null,
        shareUrl: entry.shareUrl ?? '',
        status: current?.status ?? '',
        revision,
        updatedAt: new Date(entry.sleep.armedAt).toISOString(),
        publishedBy: null,
        session: revision === entry.sleep.revision ? localSession(entry, host) : null
      })
    }
  }
  return items
}

export async function listReviewWaits(
  service: Pick<ArtifactCloudService, 'signedIn' | 'apiOrigin' | 'reviewStatus'>,
  userDataPath: string
): Promise<ReviewWaitsResult> {
  const scope = activeArtifactShareScope(userDataPath, service.apiOrigin())
  const entries = listReviewSleepEntries(service.apiOrigin(), userDataPath)
  const current = (): boolean =>
    JSON.stringify(activeArtifactShareScope(userDataPath, service.apiOrigin())) ===
    JSON.stringify(scope)
  let inbox: InboxItem[] | null = null
  try {
    const read = await service.signedIn((token, apiUrl) =>
      artifactApiRequest<{ items?: InboxItem[] }>(
        apiUrl,
        token,
        '/v1/artifact-reviews/inbox?limit=100'
      )
    )
    if (read.status === 'reconnect-required') {
      const host = await reviewHostLabel()
      if (!current()) {
        return { status: 'ok', items: [], inbox: 'unavailable' }
      }
      if (entries.length === 0) {
        return { status: 'signed-out' }
      }
      return {
        status: 'ok',
        items: mergeReviewWaits([], entries, host),
        inbox: 'signed-out'
      }
    }
    inbox = read.status === 'ok' && Array.isArray(read.value.items) ? read.value.items : null
  } catch {
    inbox = null
  }
  if (!current()) {
    return { status: 'ok', items: [], inbox: 'unavailable' }
  }
  const freshAttention = new Map<string, ArtifactReviewAttention>()
  const reconciled = scope
    ? await reconcileReviewAttention(
        entries.filter((entry) => OPEN_WAITS.has(entry.sleep.state)),
        {
          read: (slug) => service.reviewStatus({ slug }),
          current,
          observed: (slug, attention) => freshAttention.set(slug, attention),
          save: (entry, reviewAttention) =>
            Boolean(
              updateArtifactShareRecord(
                scope.profileId,
                userDataPath,
                entry.sourceKey,
                scope.scope,
                (record) => {
                  const previous = validArtifactReviewAttention(record.reviewAttention)
                    ? record.reviewAttention
                    : null
                  return record.slug === entry.slug &&
                    record.sourceReview?.revision === entry.sourceReview.revision &&
                    (!previous ||
                      (previous.revision <= reviewAttention.revision &&
                        previous.observedAt <= reviewAttention.observedAt))
                    ? { ...record, reviewAttention }
                    : null
                }
              )
            )
        }
      )
    : entries
  const host = await reviewHostLabel()
  if (!current()) {
    return { status: 'ok', items: [], inbox: 'unavailable' }
  }
  const byKey = new Map(reconciled.map((entry) => [entry.sourceKey, entry]))
  return {
    status: 'ok',
    items: mergeReviewWaits(
      inbox ?? [],
      entries.map((entry) => byKey.get(entry.sourceKey) ?? entry),
      host,
      freshAttention
    ),
    inbox: inbox ? 'ok' : 'unavailable'
  }
}
