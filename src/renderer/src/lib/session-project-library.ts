import type { ArtifactSessionRecord } from '../../../shared/artifact-session'
import type { HostedReviewState } from '../../../shared/hosted-review'
import type { SessionLinkedDocsEntry } from '../../../shared/session-linked-docs'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { sessionPanelItems } from '@/components/right-sidebar/session-artifact/session-panel-items'
import type { SessionProjectThread } from './session-project-threads'
import type { SessionProjectThreadOutput } from './session-project-thread-outputs'

export type SessionProjectLibraryItem = {
  key: string
  kind: 'review' | 'slite' | 'artifact'
  /** "#12", a page's slug, or a Slite doc id. */
  label: string
  url: string
  state?: HostedReviewState
  /** The thread that made or linked it, to open from the Library. */
  thread: SessionProjectThread
  /** When the thread published or linked it; reviews carry none and list first. */
  at: number | null
}

/**
 * What a project's threads produced, one entry per thing: each thread's pull or merge request
 * (the row chip's lookup) and the pages and Slite docs its own pane published or linked, by the
 * same rule the right panel uses for one conversation.
 */
export function sessionProjectLibrary(
  threads: readonly SessionProjectThread[],
  outputsFor: (thread: SessionProjectThread) => SessionProjectThreadOutput[],
  records: readonly ArtifactSessionRecord[],
  linked: readonly SessionLinkedDocsEntry[]
): SessionProjectLibraryItem[] {
  const byKey = new Map<string, SessionProjectLibraryItem>()
  const keep = (item: SessionProjectLibraryItem): void => {
    const previous = byKey.get(item.key)
    if (!previous || (item.at ?? -1) > (previous.at ?? -1)) {
      byKey.set(item.key, item)
    }
  }
  for (const thread of threads) {
    for (const output of outputsFor(thread)) {
      if (output.kind === 'review') {
        keep({
          key: `review:${output.url}`,
          kind: 'review',
          label: output.label,
          url: output.url,
          state: output.state,
          thread,
          at: null
        })
      }
    }
    const { session } = thread.row
    const pane = session.paneKey ? parsePaneKey(session.paneKey) : null
    if (!pane) {
      continue
    }
    const target = { worktreeId: session.worktreeId, tabId: pane.tabId, leafId: pane.leafId }
    for (const item of sessionPanelItems(records, linked, target)) {
      if (item.kind === 'slite') {
        keep({ key: item.key, kind: 'slite', label: item.id, url: item.url, thread, at: item.at })
      } else if (item.kind === 'artifact') {
        keep({
          key: item.key,
          kind: 'artifact',
          label: item.record.slug,
          url: item.record.shareUrl,
          thread,
          at: item.at
        })
      }
    }
  }
  const order = (item: SessionProjectLibraryItem): number => item.at ?? Number.MAX_SAFE_INTEGER
  return [...byKey.values()].sort((left, right) => order(right) - order(left))
}
