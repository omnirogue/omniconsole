import { translate as t } from '@/i18n/i18n'
import type { InboxAgent, InboxPerson } from './inbox-api'
import type { RoomPickerOption } from './InboxRoomPicker'

export function roomParticipants(
  people: InboxPerson[],
  agents: InboxAgent[],
  project: string
): RoomPickerOption[] {
  return people.map((person) => {
    const endpoints = agents.filter(
      (agent) => agent.employee_id === person.employee_id && agent.project_id === project
    )
    const app = endpoints.find(
      (agent) => agent.endpoint_kind === 'logical_app' || agent.session_id.startsWith('pc_')
    )
    const live = endpoints.find(
      (agent) => agent.availability === 'online' && agent.session_heartbeat_at != null
    )
    const detail = app
      ? t('inbox.room.aiInbox', 'AI Inbox · Live activity is not reported')
      : live
        ? t('inbox.room.aiRecent', 'AI session · Recent activity reported')
        : endpoints.length
          ? t('inbox.room.aiNoRecent', 'AI session · No recent activity reported')
          : person.enrolled
            ? t('inbox.room.aiOtherProject', 'No AI conversation in this project')
            : t('inbox.room.aiSetup', 'AI setup required')
    return { key: person.employee_id, title: person.name, detail, disabled: endpoints.length === 0 }
  })
}
