import type { NextStepRecipientSource } from './use-next-step-recipients'
import type { AgentCatalogEntry } from '@/lib/agent-catalog'
import type { TeamRosterPerson } from '../../../../shared/team-roster-search'
import type { OrgChartPerson } from '../../../../shared/console-companies-contract'
import { RecipientIdentityPicker } from './RecipientIdentityPicker'
import { RecipientAvatar, recipientPhoto } from './recipient-avatar'

const NO_AGENTS: readonly AgentCatalogEntry[] = []
const NO_ORG_PEOPLE: readonly OrgChartPerson[] = []

/** Explicit picks replace the previous destination. */
export function RecipientIdentityChoice({
  people,
  agents = NO_AGENTS,
  allowAI = false,
  onSelectAgent,
  selected,
  onChange,
  recipientSource,
  orgPeople = NO_ORG_PEOPLE
}: {
  agents?: readonly AgentCatalogEntry[]
  allowAI?: boolean
  onSelectAgent?: (agent: AgentCatalogEntry) => void
  people: readonly TeamRosterPerson[]
  selected: TeamRosterPerson | null
  onChange: (person: TeamRosterPerson | null) => void
  recipientSource?: Pick<NextStepRecipientSource, 'people' | 'reload'>
  orgPeople?: readonly OrgChartPerson[]
}): React.JSX.Element {
  return (
    <div className="space-y-2">
      <RecipientIdentityPicker
        people={recipientSource?.people ?? { phase: 'ready', value: [...people] }}
        agents={{ phase: 'ready', value: [...agents] }}
        selected={selected ? [{ ...selected, kind: 'person', key: selected.id }] : []}
        allowAI={allowAI}
        oneAgentOnly
        orgPeople={orgPeople}
        onToggleAgent={(entry) => onSelectAgent?.(entry)}
        onRetry={recipientSource?.reload ?? (() => {})}
        onTogglePerson={(person, ensure) =>
          onChange(!ensure && selected?.id === person.id ? null : person)
        }
      />
      {selected ? (
        <div className="flex items-center gap-2 text-xs" data-selected-recipient={selected.id}>
          <RecipientAvatar name={selected.name} photoUrl={recipientPhoto(selected, orgPeople)} />
          <span className="truncate">{selected.name}</span>
        </div>
      ) : null}
    </div>
  )
}
