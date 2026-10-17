import { useMemo } from 'react'
import { useKnownPullRequestFacts } from '@/components/goals-todos/session-pull-request-facts-store'
import {
  buildFilesAndLinksCards,
  resolveSessionFilePath,
  withKnownPullRequestState,
  type FilesAndLinksCard
} from '@/lib/session-files-and-links'
import type { SessionFileTarget } from '@/lib/session-files-and-links-actions'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { conversationWrittenFileEntries } from '../../../../shared/session-handoff-summary'
import { extractSessionLinks } from '../../../../shared/session-links'
import { conversationProducedFileEntries } from '../../../../shared/session-produced-files'
import {
  useExistingSessionFiles,
  useLoopbackLiveness,
  useSessionFileTarget,
  useWorkspaceReview,
  type LoopbackLiveness
} from './use-session-files-and-links'

const NO_MESSAGES: readonly NativeChatMessage[] = []
const NO_PATHS: readonly string[] = []

export type SessionOutputs = {
  /** Everything the session produced: PRs, previews, artifacts, service links, files. */
  cards: FilesAndLinksCard[]
  liveness: ReadonlyMap<string, LoopbackLiveness>
  target: SessionFileTarget | null
}

/**
 * The session's outputs, built once for every surface that shows them. Files come from the AI's
 * file tools and from what its commands wrote; only files that still exist are kept, checked
 * while `active` (the info card is open) within the existing cap.
 */
export function useSessionOutputs({
  worktreeId,
  hostId,
  messages = NO_MESSAGES,
  active,
  reviewOnlyWhenLinked = false,
  hookFiles = NO_PATHS
}: {
  worktreeId: string
  hostId?: string | null
  messages?: readonly NativeChatMessage[]
  active: boolean
  /** For a view of one session's own work: see buildFilesAndLinksCards. */
  reviewOnlyWhenLinked?: boolean
  /** Paths the session's write tools finished writing (main's hook record), oldest first. */
  hookFiles?: readonly string[]
}): SessionOutputs {
  const target = useSessionFileTarget(worktreeId, hostId)
  const review = useWorkspaceReview(worktreeId)
  const worktreePath = target?.worktreePath ?? null
  const files = useMemo(() => {
    const byPath = new Map<string, number>()
    const entries = [
      ...conversationWrittenFileEntries(messages),
      ...conversationProducedFileEntries(messages),
      ...hookFiles.map((path, index) => ({ path, messageIndex: messages.length + index }))
    ].sort((a, b) => a.messageIndex - b.messageIndex)
    for (const entry of entries) {
      const path = resolveSessionFilePath(entry.path, worktreePath)
      if (path) {
        byPath.delete(path)
        byPath.set(path, entry.messageIndex)
      }
    }
    return [...byPath].map(([path, messageIndex]) => ({ path, messageIndex })).toReversed()
  }, [messages, worktreePath, hookFiles])
  const links = useMemo(() => extractSessionLinks(messages), [messages])
  const paths = useMemo(() => files.map((file) => file.path), [files])
  const existing = useExistingSessionFiles(paths, target, active)
  const loopbackUrls = useMemo(
    () => links.filter((link) => link.kind === 'localhost').map((link) => link.url),
    [links]
  )
  const liveness = useLoopbackLiveness(loopbackUrls, active, hostId)
  const knownPullRequests = useKnownPullRequestFacts()
  const cards = useMemo(
    () =>
      withKnownPullRequestState(
        buildFilesAndLinksCards({
          review,
          files: files.filter((file) => existing.get(file.path) === true),
          links,
          worktreePath,
          reviewOnlyWhenLinked
        }),
        knownPullRequests
      ),
    [review, files, existing, links, worktreePath, knownPullRequests, reviewOnlyWhenLinked]
  )
  return useMemo(() => ({ cards, liveness, target }), [cards, liveness, target])
}
