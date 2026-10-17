import {
  type ArtifactSessionRecord,
  artifactContentUrl
} from '../../../../../shared/artifact-session'
import type { SessionLinkedDocsEntry } from '../../../../../shared/session-linked-docs'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import {
  type ArtifactSessionTarget,
  artifactBelongsToSession,
  artifactsForSession
} from './session-artifact-association'

/**
 * One thing the right panel can show for the conversation on screen: a page it published
 * (`omni artifacts share`) or linked (any omnios page), or a Slite doc it linked (plans, reports).
 */
export type SessionPanelItem =
  | { kind: 'artifact'; key: string; at: number; record: ArtifactSessionRecord }
  | { kind: 'slite'; key: string; at: number; id: string; url: string }
  | { kind: 'file'; key: string; at: number; path: string; context: RuntimeFileOperationArgs }

/** The on-screen conversation's items, newest first, one per document. */
export function sessionPanelItems(
  records: readonly ArtifactSessionRecord[],
  linked: readonly SessionLinkedDocsEntry[],
  target: ArtifactSessionTarget | null
): SessionPanelItem[] {
  if (!target) {
    return []
  }
  const byKey = new Map<string, SessionPanelItem>()
  const keep = (item: SessionPanelItem): void => {
    const previous = byKey.get(item.key)
    if (!previous) {
      byKey.set(item.key, item)
      return
    }
    // Why keep the published record: it names the source file; the later time still wins the order.
    const base = previous.kind === 'artifact' && previous.record.sourceKey ? previous : item
    byKey.set(item.key, { ...base, at: Math.max(previous.at, item.at) } as SessionPanelItem)
  }
  for (const record of artifactsForSession(records, target)) {
    keep({ kind: 'artifact', key: `artifact:${record.slug}`, at: record.savedAt ?? -1, record })
  }
  for (const entry of linked) {
    // Same rule as a published page: only the conversation whose reply linked it.
    if (!artifactBelongsToSession({ origin: { paneKey: entry.paneKey } }, target)) {
      continue
    }
    for (const doc of entry.docs) {
      if (doc.kind === 'slite') {
        keep({ kind: 'slite', key: `slite:${doc.id}`, at: doc.seenAt, id: doc.id, url: doc.url })
      } else if (entry.apiOrigin) {
        keep({
          kind: 'artifact',
          key: `artifact:${doc.slug}`,
          at: doc.seenAt,
          record: {
            slug: doc.slug,
            shareUrl: doc.url,
            sourceKey: '',
            savedAt: doc.seenAt,
            contentUrl: artifactContentUrl(entry.apiOrigin, doc.slug),
            origin: { paneKey: entry.paneKey }
          }
        })
      }
    }
  }
  return [...byKey.values()].sort((left, right) => right.at - left.at)
}
