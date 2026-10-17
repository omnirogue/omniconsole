import { useMemo, useState } from 'react'
import { Check, ChevronsUpDown, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import { joinNames } from '@/lib/session-follow-up-messages'
import { cn } from '@/lib/utils'
import { SESSION_FOLLOW_UP_MAX_RECIPIENTS } from '../../../../shared/session-follow-up-rule'
import {
  duplicateRosterNames,
  foldPersonName,
  rosterPersonDetail,
  searchRoster,
  type TeamRosterPerson
} from '../../../../shared/team-roster-search'

const PAGE_SIZE = 50

/** Searchable multi-select over the active human roster; shared names show who is who. */
export function SessionFollowUpRecipientPicker({
  id,
  roster,
  selected,
  loading,
  disabled,
  onChange
}: {
  id: string
  roster: readonly TeamRosterPerson[]
  selected: readonly TeamRosterPerson[]
  loading: boolean
  disabled?: boolean
  onChange: (people: TeamRosterPerson[]) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(PAGE_SIZE)
  const duplicates = useMemo(() => duplicateRosterNames(roster), [roster])
  const result = useMemo(() => searchRoster(roster, query, limit), [roster, query, limit])
  const selectedIds = new Set(selected.map((person) => person.id))
  const full = selected.length >= SESSION_FOLLOW_UP_MAX_RECIPIENTS
  const toggle = (person: TeamRosterPerson): void => {
    if (selectedIds.has(person.id)) {
      onChange(selected.filter((entry) => entry.id !== person.id))
    } else if (!full) {
      onChange([...selected, person])
    }
  }
  const detail = (person: TeamRosterPerson): string | null =>
    rosterPersonDetail(person) ?? (duplicates.has(foldPersonName(person.name)) ? person.id : null)
  return (
    <div className="space-y-2">
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) {
            setQuery('')
            setLimit(PAGE_SIZE)
          }
        }}
      >
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={disabled || loading}
            className="h-9 w-full justify-between px-3 text-sm font-normal"
          >
            <span className="truncate">
              {loading
                ? translate('sessionFollowUp.loadingTeammates', 'Loading teammates…')
                : selected.length > 0
                  ? joinNames(selected.map((person) => person.name))
                  : translate('sessionFollowUp.choosePeople', 'Choose people')}
            </span>
            <ChevronsUpDown className="size-3.5 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-[min(360px,calc(100vw-1rem))] min-w-[var(--radix-popover-trigger-width)] p-0"
        >
          <Command shouldFilter={false}>
            <CommandInput
              autoFocus
              placeholder={translate('sessionFollowUp.searchTeammates', 'Search teammates…')}
              value={query}
              onValueChange={(value) => {
                setQuery(value)
                setLimit(PAGE_SIZE)
              }}
              className="text-xs"
            />
            <CommandList>
              <CommandEmpty>
                {translate('sessionFollowUp.noTeammateMatches', 'No active teammate matches.')}
              </CommandEmpty>
              {result.people.map((person) => {
                const line = detail(person)
                return (
                  <CommandItem
                    key={person.id}
                    value={person.id}
                    disabled={full && !selectedIds.has(person.id)}
                    onSelect={() => toggle(person)}
                    className="items-center gap-2 px-3 py-1.5 text-xs"
                  >
                    <Check
                      className={cn(
                        'size-3 text-muted-foreground',
                        selectedIds.has(person.id) ? 'opacity-70' : 'opacity-0'
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <span className="block truncate">{person.name}</span>
                      {line ? (
                        <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                          {line}
                        </span>
                      ) : null}
                    </div>
                  </CommandItem>
                )
              })}
            </CommandList>
            {full ? (
              <p className="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
                {translate(
                  'sessionFollowUp.tooManyPeople',
                  'One next step goes to at most 20 people.'
                )}
              </p>
            ) : null}
            {result.total > result.people.length ? (
              <div className="border-t border-border p-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="w-full"
                  onClick={() => setLimit((value) => value + PAGE_SIZE)}
                >
                  {translate('sessionFollowUp.showMorePeople', 'Show {{count}} more', {
                    count: Math.min(PAGE_SIZE, result.total - result.people.length)
                  })}
                </Button>
              </div>
            ) : null}
          </Command>
        </PopoverContent>
      </Popover>
      {selected.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {selected.map((person) => (
            <Badge key={person.id} variant="secondary" className="gap-1">
              {person.name}
              <button
                type="button"
                disabled={disabled}
                aria-label={translate('sessionFollowUp.removePerson', 'Remove {{name}}', {
                  name: person.name
                })}
                onClick={() => toggle(person)}
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  )
}
