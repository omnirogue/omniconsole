import { useId, useMemo, useRef, useState } from 'react'
import { Bot, Check, User, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import type { AgentCatalogEntry } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import type { NextStepRecipient } from '../../../../shared/next-step-draft'
import {
  rosterPersonDetail,
  searchRoster,
  type TeamRosterPerson
} from '../../../../shared/team-roster-search'
import type { NextStepLoad } from './use-next-step-recipients'

import type { OrgChartPerson } from '../../../../shared/console-companies-contract'
import { RecipientAvatar, recipientPhoto } from './recipient-avatar'
import { useMeRecipient } from './use-me-recipient'

const PEOPLE_SHOWN = 12
const NO_ORG_PEOPLE: readonly OrgChartPerson[] = []

function Row({
  selected,
  disabled,
  icon,
  label,
  detail,
  onToggle,
  testId
}: {
  selected: boolean
  disabled?: boolean
  icon: React.ReactNode
  label: string
  detail?: string | null
  onToggle: () => void
  testId: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      disabled={disabled}
      data-next-step-recipient={testId}
      onClick={onToggle}
      className={cn(
        'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-accent disabled:opacity-50',
        selected && 'bg-accent'
      )}
    >
      <Check className={cn('size-3 shrink-0', selected ? 'opacity-80' : 'opacity-0')} />
      <span className="inline-flex shrink-0" aria-hidden="true">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {detail ? (
          <span className="block truncate text-[10px] text-muted-foreground">{detail}</span>
        ) : null}
      </span>
    </button>
  )
}

function Section({
  title,
  icon,
  children
}: {
  title: string
  icon: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex items-center gap-1.5 px-2 text-[11px] font-medium text-muted-foreground">
        {icon}
        {title}
      </div>
      {children}
    </div>
  )
}

export function RecipientIdentityPicker({
  agents,
  people,
  selected,
  oneAgentOnly,
  onToggleAgent,
  onTogglePerson,
  onRetry,
  allowAI = true,
  orgPeople = NO_ORG_PEOPLE
}: {
  agents: NextStepLoad<AgentCatalogEntry[]>
  people: NextStepLoad<TeamRosterPerson[]>
  selected: readonly NextStepRecipient[]
  /** A card or thread starts one workspace; a second agent would need a session. */
  oneAgentOnly: boolean
  onToggleAgent: (entry: AgentCatalogEntry) => void
  onTogglePerson: (person: TeamRosterPerson, ensureSelected?: boolean) => void
  allowAI?: boolean
  orgPeople?: readonly OrgChartPerson[]
  onRetry: () => void
}): React.JSX.Element {
  const [choice, setChoice] = useState<'me' | 'people' | 'ai'>('me')
  const userTouchedRef = useRef(false)
  const me = useMeRecipient(people, selected, userTouchedRef, onTogglePerson)
  const reasonId = useId()
  const statusId = useId()
  const [query, setQuery] = useState('')
  const selectedAgents = new Set(
    selected.filter((recipient) => recipient.kind === 'agent').map((recipient) => recipient.agent)
  )
  const selectedPeople = new Set(
    selected.filter((recipient) => recipient.kind === 'person').map((recipient) => recipient.id)
  )
  const meSelected = !!me.person && selectedPeople.has(me.person.id)
  const touch = (): void => {
    userTouchedRef.current = true
  }
  const enterPicker = (next: 'people' | 'ai'): void => {
    if (
      me.autoPickedRef.current &&
      !userTouchedRef.current &&
      me.person &&
      selected.length === 1 &&
      selected[0]?.kind === 'person' &&
      selected[0].id === me.person.id
    ) {
      onTogglePerson(me.person)
    }
    touch()
    setChoice(next)
    setQuery('')
  }
  const folded = query.trim().toLowerCase()
  const agentRows = useMemo(
    () =>
      agents.phase === 'ready'
        ? agents.value.filter((entry) => !folded || entry.label.toLowerCase().includes(folded))
        : [],
    [agents, folded]
  )
  const peopleRows = useMemo(
    () => (people.phase === 'ready' ? searchRoster(people.value, query, PEOPLE_SHOWN) : null),
    [people, query]
  )
  const agentLocked = oneAgentOnly && selectedAgents.size > 0
  return (
    <div className="space-y-2" data-next-step-recipients>
      <div className={cn('grid gap-2', allowAI ? 'grid-cols-3' : 'grid-cols-2')}>
        <Button
          type="button"
          variant="outline"
          disabled={!me.person}
          aria-describedby={
            [!me.person && choice === 'me' ? reasonId : null, meSelected ? statusId : null]
              .filter((id): id is string => id !== null)
              .join(' ') || undefined
          }
          onClick={() => {
            touch()
            setChoice('me')
            setQuery('')
            if (me.person) {
              onTogglePerson(me.person, true)
            }
          }}
          data-testid="recipient-category-me"
          className={cn('recipient-identity-human', choice === 'me' && 'ring-1 ring-ring')}
        >
          <User aria-hidden="true" />
          {translate('nextStep.me', 'Me')}
          {meSelected ? <Check className="size-3" aria-hidden="true" /> : null}
        </Button>
        <Button
          type="button"
          variant="outline"
          aria-pressed={choice === 'people'}
          onClick={() => enterPicker('people')}
          data-testid="recipient-category-people"
          className={cn('recipient-identity-human', choice === 'people' && 'ring-1 ring-ring')}
        >
          <Users aria-hidden="true" />
          {translate('nextStep.someoneElse', 'Someone else')}
        </Button>
        {allowAI ? (
          <Button
            type="button"
            variant="outline"
            aria-pressed={choice === 'ai'}
            onClick={() => enterPicker('ai')}
            data-testid="recipient-category-ai"
            className={cn('recipient-identity-ai', choice === 'ai' && 'ring-1 ring-ring')}
          >
            <Bot aria-hidden="true" />
            {translate('nextStep.ai', 'AI')}
          </Button>
        ) : null}
      </div>
      {meSelected ? (
        <span id={statusId} className="sr-only">
          {translate('nextStep.included', 'included')}
        </span>
      ) : null}
      {!me.person && choice === 'me' ? (
        <div id={reasonId} className="space-y-1 text-xs text-muted-foreground">
          <p>
            {me.loading
              ? translate('nextStep.meLoading', 'Finding your employee profile…')
              : me.profileError
                ? translate('nextStep.meProfileError', "Couldn't check your sign-in: {{message}}", {
                    message: me.profileError
                  })
                : me.rosterError
                  ? translate('nextStep.meRosterError', "Couldn't load your team: {{message}}", {
                      message: me.rosterError
                    })
                  : translate(
                      'nextStep.meUnavailable',
                      'Me is unavailable: your console profile has no matching employee in this roster.'
                    )}
          </p>
          {me.profileError ? (
            <Button type="button" size="xs" variant="outline" onClick={me.reloadProfile}>
              {translate('sessionFollowUp.retryLoad', 'Try again')}
            </Button>
          ) : me.rosterError ? (
            <Button type="button" size="xs" variant="outline" onClick={onRetry}>
              {translate('sessionFollowUp.retryLoad', 'Try again')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {choice !== 'me' ? (
        <Input
          value={query}
          onFocus={() => {
            if (choice === 'people') {
              onRetry()
            }
          }}
          onChange={(event) => {
            touch()
            setQuery(event.target.value)
          }}
          placeholder={translate('nextStep.searchRecipients', 'Search agents and people…')}
          aria-label={translate('nextStep.whereQuestion', 'WHERE')}
          className="h-8 text-xs"
          autoFocus
        />
      ) : null}
      <div className="space-y-3">
        {choice === 'ai' ? (
          <Section title={translate('nextStep.agents', 'Agents')} icon={<Bot className="size-3" />}>
            {agents.phase === 'loading' ? (
              <p className="px-2 text-[11px] text-muted-foreground">
                {translate(
                  'auto.components.SessionSidebar.checkingAgents',
                  'Checking agents on this host…'
                )}
              </p>
            ) : agents.phase === 'error' ? (
              <p className="px-2 text-[11px] text-destructive">{agents.message}</p>
            ) : agentRows.length === 0 ? (
              <p className="px-2 text-[11px] text-muted-foreground">
                {folded
                  ? translate('nextStep.noAgentMatches', 'No agent matches that.')
                  : translate(
                      'auto.components.SessionSidebar.noEnabledAgents',
                      'No enabled agents were detected on this host.'
                    )}
              </p>
            ) : (
              agentRows.map((entry) => (
                <Row
                  key={entry.id}
                  testId={`agent:${entry.id}`}
                  selected={selectedAgents.has(entry.id)}
                  disabled={agentLocked && !selectedAgents.has(entry.id)}
                  icon={<RecipientAvatar agent />}
                  label={entry.label}
                  onToggle={() => {
                    touch()
                    onToggleAgent(entry)
                  }}
                />
              ))
            )}
            {agentLocked ? (
              <p className="px-2 text-[10px] text-muted-foreground">
                {translate(
                  'nextStep.oneAgentHere',
                  'One agent at a time here; several run in parallel on a session.'
                )}
              </p>
            ) : null}
          </Section>
        ) : null}
        {choice === 'people' ? (
          <Section
            title={translate('nextStep.people', 'People')}
            icon={<Users className="size-3" />}
          >
            {people.phase === 'loading' ? (
              <p className="px-2 text-[11px] text-muted-foreground">
                {translate('sessionFollowUp.loadingTeammates', 'Loading teammates…')}
              </p>
            ) : people.phase === 'error' ? (
              <div className="space-y-1 px-2">
                <p className="text-[11px] text-destructive">{people.message}</p>
                <Button type="button" size="xs" variant="outline" onClick={onRetry}>
                  {translate('sessionFollowUp.retryLoad', 'Try again')}
                </Button>
              </div>
            ) : !peopleRows || peopleRows.people.length === 0 ? (
              <p className="px-2 text-[11px] text-muted-foreground">
                {folded
                  ? translate('sessionFollowUp.noTeammateMatches', 'No active teammate matches.')
                  : translate(
                      'nextStep.noPeopleAvailable',
                      'No teammates are available for your account.'
                    )}
                {!folded ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={onRetry}
                    className="ml-2"
                  >
                    {translate('nextStep.refreshPeople', 'Refresh people')}
                  </Button>
                ) : null}
              </p>
            ) : (
              <>
                {peopleRows.people.map((person) => (
                  <Row
                    key={person.id}
                    testId={`person:${person.id}`}
                    selected={selectedPeople.has(person.id)}
                    icon={
                      <RecipientAvatar
                        name={person.name}
                        photoUrl={recipientPhoto(person, orgPeople)}
                      />
                    }
                    label={person.name}
                    detail={rosterPersonDetail(person)}
                    onToggle={() => {
                      touch()
                      onTogglePerson(person)
                    }}
                  />
                ))}
                {peopleRows.total > peopleRows.people.length ? (
                  <p className="px-2 text-[10px] text-muted-foreground">
                    {translate('nextStep.morePeople', 'Search to find {{count}} more.', {
                      count: peopleRows.total - peopleRows.people.length
                    })}
                  </p>
                ) : null}
              </>
            )}
          </Section>
        ) : null}
      </div>
    </div>
  )
}
