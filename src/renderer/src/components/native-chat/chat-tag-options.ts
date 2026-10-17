import { translate } from '@/i18n/i18n'
import type { TeamRosterPerson } from '../../../../shared/team-roster-search'
import type { ChatAgentRecipient } from '../../../../shared/console-chat-agent-contract'
import { filterChatTagOptions, type ChatTagOption } from './ChatRecipientPicker'

export function chatTagOptions(
  people: TeamRosterPerson[],
  agents: ChatAgentRecipient[],
  query: string | null,
  directDelivery: boolean
): ChatTagOption[] {
  const paths = !query || /[./\\]/.test(query)
  return filterChatTagOptions(
    [
      ...people.map((person): ChatTagOption => ({
        id: `person:${person.id}`,
        label: person.name,
        detail: person.department ?? person.title,
        kind: 'person',
        recipient: { kind: 'person', id: person.id, name: person.name }
      })),
      ...agents.map((agent): ChatTagOption => ({
        id: `agent:${agent.id}`,
        label: agent.name,
        detail: [agent.provider, agent.projectName].filter(Boolean).join(' · '),
        kind: 'agent',
        recipient: {
          kind: 'agent',
          id: agent.id,
          name: agent.name,
          employeeId: agent.employeeId,
          projectId: agent.projectId
        }
      })),
      ...(paths && query && !directDelivery
        ? [{ id: 'reference', label: query, kind: 'reference' as const }]
        : []),
      ...(paths
        ? [
            {
              id: 'file',
              label: translate('chatDelivery.chooseFile', 'Choose file…'),
              kind: 'file' as const
            },
            {
              id: 'folder',
              label: translate('chatDelivery.chooseFolder', 'Choose folder…'),
              kind: 'folder' as const
            }
          ]
        : [])
    ],
    query ?? ''
  )
}
