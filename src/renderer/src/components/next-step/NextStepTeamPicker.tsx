import { useMemo, useState } from 'react'
import { Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { ChatRecipient } from '../../../../shared/chat-delivery'
import type { OrgChartPerson } from '../../../../shared/console-companies-contract'
import {
  rosterPersonDetail,
  searchRoster,
  type TeamRosterPerson
} from '../../../../shared/team-roster-search'
import { NextStepAgentRecipientChoice } from './NextStepAgentRecipientChoice'
import { RecipientAvatar, recipientPhoto } from './recipient-avatar'
import type { NextStepLoad } from './use-next-step-recipients'

const PEOPLE_SHOWN = 12
/** Below this many teammates the rows are the whole picker; a search box would only add a step. */
const SEARCH_FROM = 8
const NO_ORG_PEOPLE: readonly OrgChartPerson[] = []

/**
 * The teammates — photo first, then name, role muted — where one click chooses. An existing
 * employee agent session stays available underneath, exactly as before.
 */
export function NextStepTeamPicker({
  people,
  orgPeople = NO_ORG_PEOPLE,
  selectedId,
  onSelect,
  onRetry,
  agentRecipient,
  onAgentRecipient
}: {
  people: NextStepLoad<TeamRosterPerson[]>
  orgPeople?: readonly OrgChartPerson[]
  selectedId: string | null
  onSelect: (person: TeamRosterPerson) => void
  onRetry: () => void
  agentRecipient?: Extract<ChatRecipient, { kind: 'agent' }>
  onAgentRecipient: (recipient: Extract<ChatRecipient, { kind: 'agent' }>) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const roster = people.phase === 'ready' ? people.value : null
  const rows = useMemo(
    () => (roster ? searchRoster(roster, query, PEOPLE_SHOWN) : null),
    [roster, query]
  )
  return (
    <div className="space-y-2" data-next-step-team-picker>
      {roster && roster.length >= SEARCH_FROM ? (
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={translate('nextStep.findTeammate', 'Find a teammate…')}
          aria-label={translate('nextStep.findTeammate', 'Find a teammate…')}
          className="h-7 text-xs"
        />
      ) : null}
      {people.phase === 'loading' ? (
        <p className="text-[11px] text-muted-foreground">
          {translate('sessionFollowUp.loadingTeammates', 'Loading teammates…')}
        </p>
      ) : people.phase === 'error' ? (
        <div className="space-y-1">
          <p className="text-[11px] text-destructive">{people.message}</p>
          <Button type="button" size="xs" variant="outline" onClick={onRetry}>
            {translate('sessionFollowUp.retryLoad', 'Try again')}
          </Button>
        </div>
      ) : !rows || rows.people.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          {query.trim()
            ? translate('sessionFollowUp.noTeammateMatches', 'No active teammate matches.')
            : translate(
                'nextStep.noPeopleAvailable',
                'No teammates are available for your account.'
              )}
          {!query.trim() ? (
            <Button type="button" size="xs" variant="outline" onClick={onRetry} className="ml-2">
              {translate('nextStep.refreshPeople', 'Refresh people')}
            </Button>
          ) : null}
        </p>
      ) : (
        <div
          className="grid grid-cols-2 gap-0.5"
          role="group"
          aria-label={translate('nextStep.people', 'People')}
        >
          {rows.people.map((person) => {
            const selected = person.id === selectedId
            const detail = rosterPersonDetail(person)
            return (
              <button
                key={person.id}
                type="button"
                aria-pressed={selected}
                data-next-step-recipient={`person:${person.id}`}
                onClick={() => onSelect(person)}
                className={cn(
                  'flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  selected && 'bg-accent'
                )}
              >
                <RecipientAvatar name={person.name} photoUrl={recipientPhoto(person, orgPeople)} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{person.name}</span>
                  {detail ? (
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {detail}
                    </span>
                  ) : null}
                </span>
                {selected ? <Check className="size-3 shrink-0" aria-hidden /> : null}
              </button>
            )
          })}
          {rows.total > rows.people.length ? (
            <p className="col-span-2 text-[10px] text-muted-foreground">
              {translate('nextStep.morePeople', 'Search to find {{count}} more.', {
                count: rows.total - rows.people.length
              })}
            </p>
          ) : null}
        </div>
      )}
      {/* Why: an existing employee agent session takes the work as an FYI it owns; nothing
          starts a replacement agent and no review round-trip applies. */}
      <div className="border-t border-border/60 pt-2">
        <NextStepAgentRecipientChoice
          value={agentRecipient}
          orgPeople={orgPeople}
          onChange={onAgentRecipient}
        />
      </div>
    </div>
  )
}
