/**
 * The `jira` kind: a human comment on a prototype's Jira issue (Iris's QA reply) for the session
 * bound to that issue. OmniOS composes the message (fix what you can now; a decision page only for
 * a real choice); the brief for a respawn adds the thread and the last agent handoff.
 */

import { formatSessionReference } from '../../shared/session-reference'
import type { ClaimableDelivery, WorkDeliveryKindAdapter } from './work-delivery-kind'

type ThreadComment = { author?: string; created?: string; agent?: boolean; text?: string }
type JiraContext = {
  issue?: string
  summary?: string
  thread?: ThreadComment[]
  lastHandoff?: { created?: string; text?: string } | null
}

export function jiraRespawnBrief(delivery: ClaimableDelivery): string {
  const context = delivery.context as JiraContext
  const key = context.issue ?? delivery.workItem.replace(/^jira:/, '')
  const thread = (context.thread ?? [])
    .map(
      (c) =>
        `--- ${c.author ?? 'someone'}${c.agent ? ' (agent)' : ''}, ${c.created ?? ''}\n${c.text ?? ''}`
    )
    .join('\n\n')
  const handoff = context.lastHandoff?.text
  return [
    `You are taking over ${key}${context.summary ? ` (${context.summary})` : ''}. The session that owned it can no longer be reopened (its transcript is gone), so you are its replacement: work in this folder, with this model and effort.`,
    handoff
      ? `The last handoff the previous session posted on ${key}:\n\n${handoff}`
      : `No earlier agent handoff was found on ${key}.`,
    thread ? `The recent thread on ${key}:\n\n${thread}` : '',
    `The new reply that needs you now:\n\n${delivery.text}`
  ]
    .filter(Boolean)
    .join('\n\n')
}

export const jiraWorkDeliveryAdapter: WorkDeliveryKindAdapter = {
  kind: 'jira',
  resolve: async (delivery) => {
    const owner = delivery.owner
    if (!owner?.conversationId || !owner.provider) {
      return null
    }
    return {
      ref: formatSessionReference({
        agent: owner.provider as 'claude' | 'codex',
        sessionId: owner.conversationId,
        hostId: 'local'
      }),
      ...(owner.paneKey ? { paneKey: owner.paneKey } : {}),
      ...(owner.accountId ? { accountId: owner.accountId } : {}),
      ...(owner.model ? { model: owner.model } : {}),
      ...(owner.effort ? { effort: owner.effort } : {}),
      ...(owner.folder ? { folder: owner.folder } : {}),
      transcript: 'present'
    }
  },
  text: (delivery) => delivery.text,
  respawnBrief: (delivery) => jiraRespawnBrief(delivery)
}
