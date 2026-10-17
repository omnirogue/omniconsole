import type { NativeChatMessage } from './native-chat-types'
import { sessionPullRequestKey, type SessionPullRequestRef } from './session-pull-request-facts'
import { sessionLinksInText } from './session-links'

/** Enough for a paired multi-brand change; more is a session that surveyed PRs, not made them. */
export const SESSION_PULL_REQUEST_LIMIT = 6

/** A pull request the session's AI named, with when it first did. */
export type SessionPullRequestMention = SessionPullRequestRef & {
  /** Position of its first and latest mention across the whole transcript. */
  firstOrder: number
  lastOrder: number
  /** Epoch ms of the first message naming it; null when the transcript has no time. */
  firstAt: number | null
}

const refsByMessage = new WeakMap<NativeChatMessage, SessionPullRequestRef[]>()

/** PR links in one assistant message's prose, in order; cached per message object. */
function refsInMessage(message: NativeChatMessage): SessionPullRequestRef[] {
  const cached = refsByMessage.get(message)
  if (cached) {
    return cached
  }
  const refs = message.blocks
    .flatMap((block) => (block.type === 'text' ? sessionLinksInText(block.text) : []))
    .flatMap((link) => (link.pullRequest ? [link.pullRequest] : []))
  refsByMessage.set(message, refs)
  return refs
}

/**
 * The pull requests a session's AI named in its own replies: the `limit` most recently named,
 * in the order they were first named. Tool output is left out on purpose: `gh pr list` or a
 * log names PRs the session never worked on.
 */
export function sessionPullRequestMentions(
  messages: readonly NativeChatMessage[],
  limit = SESSION_PULL_REQUEST_LIMIT
): SessionPullRequestMention[] {
  const byKey = new Map<string, SessionPullRequestMention>()
  let order = 0
  for (const message of messages) {
    if (message.role !== 'assistant') {
      continue
    }
    for (const ref of refsInMessage(message)) {
      order += 1
      const key = sessionPullRequestKey(ref)
      const known = byKey.get(key)
      byKey.set(
        key,
        known
          ? { ...known, lastOrder: order }
          : { ...ref, firstOrder: order, lastOrder: order, firstAt: message.timestamp }
      )
    }
  }
  return [...byKey.values()]
    .sort((a, b) => b.lastOrder - a.lastOrder)
    .slice(0, limit)
    .sort((a, b) => a.firstOrder - b.firstOrder)
}

/** The same pull requests as bare references, most recently named first. */
export function sessionPullRequestRefs(
  messages: readonly NativeChatMessage[],
  limit = SESSION_PULL_REQUEST_LIMIT
): SessionPullRequestRef[] {
  // Why copy-then-sort: mobile's Hermes has no Array.prototype.toSorted.
  return [...sessionPullRequestMentions(messages, limit)]
    .sort((a, b) => b.lastOrder - a.lastOrder)
    .map(({ owner, repo, number }) => ({ owner, repo, number }))
}
