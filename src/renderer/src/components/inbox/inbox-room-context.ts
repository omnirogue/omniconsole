import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { BackofficeTodoItem } from '../../../../shared/backoffice-work-types'
import { peerInstruction } from './inbox-handoff'
import { formatRoomBrief, ROOM_FACILITATION_RULES, type RoomBrief } from './inbox-room-brief'

export type RoomContext = {
  key: string
  kind: 'session' | 'task'
  title: string
  detail: string
  reference: Record<string, string | null>
}

export function roomSessionContext(session: SidebarSession): RoomContext {
  return {
    key: `session:${session.rowKey}`,
    kind: 'session',
    title: session.label,
    detail: `${session.workspaceLabel} · ${session.agent}${session.unavailable ? ' · Unavailable' : ''}`,
    reference: {
      sessionKey: session.sessionKey,
      worktreeId: session.worktreeId,
      hostId: session.hostId,
      tabId: session.tabId,
      paneKey: session.paneKey,
      sessionKind: session.kind
    }
  }
}

export function roomTaskContexts(items: BackofficeTodoItem[], project: string): RoomContext[] {
  return [
    ...new Map(
      items
        .filter(
          (item) => /^btk_[A-Za-z0-9]{4,64}$/.test(item.task_id) && item.project_id === project
        )
        .map((item): [string, RoomContext] => [
          item.task_id,
          {
            key: `task:${item.task_id}`,
            kind: 'task',
            title: item.title,
            detail: [item.who, item.status].filter(Boolean).join(' · '),
            reference: { task_id: item.task_id, project_id: project }
          }
        ])
    ).values()
  ]
}

export function roomInstruction(
  project: string,
  name: string,
  request: string,
  invite: string[],
  contexts: RoomContext[],
  brief?: RoomBrief
): string {
  if (!name.trim() || !request.trim()) {
    throw new Error('Add a title and explain what you need.')
  }
  if (!invite.length) {
    throw new Error('Choose at least one participant.')
  }
  const opening = roomOpeningMessage(request, contexts, brief)
  const instruction = peerInstruction(project, 'room_create', {
    name: name.trim(),
    invite,
    opening_message: opening,
    context_references: contexts.map(({ kind, title, reference }) => ({
      kind,
      title,
      ...reference
    }))
  })
  return brief ? `${instruction}\n\n${ROOM_FACILITATION_RULES}` : instruction
}

export function roomOpeningMessage(
  request: string,
  contexts: RoomContext[],
  brief?: RoomBrief
): string {
  const opening = [
    request.trim(),
    ...(brief ? [formatRoomBrief(brief)] : []),
    ...contexts.map(
      (context) =>
        `${context.kind === 'session' ? 'Session' : 'Task'}: ${context.title}${context.kind === 'task' ? ` (${context.reference.task_id})` : ''}`
    )
  ].join('\n\n')
  if (new TextEncoder().encode(opening).length > 2048) {
    throw new Error('Shorten your request or remove context to fit the room message limit.')
  }
  return opening
}
