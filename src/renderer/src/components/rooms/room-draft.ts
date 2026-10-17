import { parseMentions, type MentionRegistry } from '../../../../shared/room-mentions'
import type { RoomDetail } from '../../../../shared/rooms'

export function roomDraft(draft: string, detail: RoomDetail, registry: MentionRegistry) {
  const parsed = parseMentions(draft, detail, registry)
  // Count from all spans: manual mentions must not consume the parser's five target slots.
  const automatic = new Set(
    detail.agents.filter((agent) => agent.mode === 'mentions').map((agent) => agent.id)
  )
  const targetAgentIds = [
    ...new Set(
      parsed.spans
        .filter((span) => span.kind === 'agent' && automatic.has(span.id))
        .map((span) => span.id)
    )
  ]
  const content = parsed.text.trim()
  return {
    content,
    targetAgentIds,
    mentionedUserIds: parsed.userIds,
    spans: parsed.spans,
    valid:
      content.length > 0 &&
      content.length <= 3000 &&
      new TextEncoder().encode(content).length <= 12000 &&
      targetAgentIds.length <= 5 &&
      parsed.userIds.length <= 20
  }
}
