import { useRef, useState, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Command,
  CommandInput,
  CommandList,
  CommandItem,
  CommandEmpty
} from '@/components/ui/command'
import { useHandoffPeople } from '@/components/next-step/use-handoff-people'
import { translate } from '@/i18n/i18n'
import type { TeamRosterPerson } from '../../../../shared/team-roster-search'
import { sharePeopleError } from './share-people-error'

export type SharePeopleProps = {
  subjectKind: 'routine'
  subjectLabel: string
  owner?: TeamRosterPerson
  collaborators?: readonly TeamRosterPerson[]
  /** Undefined means membership is unavailable; the hub still authorizes every add. */
  canManage?: boolean
  /** A subject-specific status line, e.g. a pending ownership transfer. */
  notice?: string
  onAdd: (employeeId: string) => Promise<void>
  onRemove?: (employeeId: string) => Promise<void>
  children: ReactNode
}

function SharePeopleContent({ owner, collaborators, canManage, notice, onAdd }: SharePeopleProps) {
  const { people, peopleIncomplete, reload } = useHandoffPeople()
  const [added, setAdded] = useState<TeamRosterPerson[]>([])
  const [pending, setPending] = useState<TeamRosterPerson | null>(null)
  const [error, setError] = useState<string | null>(null)
  const busy = useRef(false)
  const members = [...(collaborators ?? []), ...added].filter(
    (person, index, all) => all.findIndex((entry) => entry.id === person.id) === index
  )
  const excluded = new Set([owner?.id, ...members.map((person) => person.id), pending?.id])
  const add = async (person: TeamRosterPerson): Promise<void> => {
    if (busy.current || canManage === false) {
      return
    }
    busy.current = true
    setPending(person)
    setError(null)
    try {
      await onAdd(person.id)
      setAdded((current) => [...current, person])
    } catch (reason) {
      setError(sharePeopleError(reason))
    } finally {
      busy.current = false
      setPending(null)
    }
  }
  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">
        {translate('sharePeople.routineHeading', 'People on this routine')}
      </p>
      {notice ? <p className="text-xs text-muted-foreground">{notice}</p> : null}
      {collaborators === undefined ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'sharePeople.membersUnavailable',
            'The hub has not provided owner or collaborator details. Only the owner can share; the hub checks each request.'
          )}
        </p>
      ) : null}
      <ul className="space-y-2 text-xs">
        {owner ? (
          <li className="flex justify-between gap-2">
            <span>{owner.name}</span>
            <span className="text-muted-foreground">{translate('sharePeople.owner', 'Owner')}</span>
          </li>
        ) : null}
        {members.map((person) => (
          <li key={person.id} className="flex justify-between gap-2">
            <span>{person.name}</span>
            <span className="text-muted-foreground">
              {translate('sharePeople.canTalk', 'Can talk to the AI')}
            </span>
          </li>
        ))}
        {pending ? (
          <li aria-busy="true" className="flex items-center gap-2">
            <Loader2 className="size-3.5 animate-spin" />
            {pending.name}
            <span>{translate('sharePeople.adding', 'Adding…')}</span>
          </li>
        ) : null}
      </ul>
      {canManage === false ? (
        <p className="text-xs text-muted-foreground">
          {translate('sharePeople.ownerRequired', 'Only the owner can share this routine.')}
        </p>
      ) : (
        <>
          {people.phase === 'loading' ? (
            <p role="status" className="text-xs">
              {translate('sharePeople.loading', 'Loading people…')}
            </p>
          ) : people.phase === 'error' ? (
            <div role="alert" className="text-xs text-destructive">
              {people.message}
              <Button variant="ghost" size="xs" onClick={reload}>
                {translate('sharePeople.retry', 'Retry')}
              </Button>
            </div>
          ) : (
            // cmdk names its input from this label (aria-labelledby), not from aria-label.
            <Command label={translate('sharePeople.add', 'Add a person…')}>
              <CommandInput placeholder={translate('sharePeople.add', 'Add a person…')} />
              <CommandList>
                <CommandEmpty>
                  {translate('sharePeople.noMatches', 'No matching people.')}
                </CommandEmpty>
                {people.value
                  .filter(
                    (person) =>
                      /^emp_[A-Za-z0-9_]{1,128}$/.test(person.id) && !excluded.has(person.id)
                  )
                  .map((person) => (
                    <CommandItem
                      className="jump-palette-item"
                      key={person.id}
                      value={`${person.name} ${person.id}`}
                      disabled={pending !== null}
                      onSelect={() => void add(person)}
                    >
                      {person.name}
                    </CommandItem>
                  ))}
              </CommandList>
            </Command>
          )}
          {peopleIncomplete ? (
            <p className="text-xs text-muted-foreground">
              {translate(
                'sharePeople.incomplete',
                'Some people may be missing. Refresh to try again.'
              )}
            </p>
          ) : null}
        </>
      )}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export function SharePeoplePopover(props: SharePeopleProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{props.children}</PopoverTrigger>
      <PopoverContent
        side="right"
        align="start"
        className="w-80 p-3"
        aria-label={translate('sharePeople.label', 'People on {{name}}', {
          name: props.subjectLabel
        })}
      >
        {open ? <SharePeopleContent {...props} /> : null}
      </PopoverContent>
    </Popover>
  )
}
