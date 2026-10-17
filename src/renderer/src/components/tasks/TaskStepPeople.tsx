import { Check, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { translate } from '@/i18n/i18n'
import type { TeamRosterPerson } from '../../../../shared/team-roster-search'

export function TaskStepPeople({
  value,
  people,
  onChange,
  disabled,
  number
}: {
  value: string[]
  people: readonly TeamRosterPerson[]
  onChange: (ids: string[]) => void
  disabled?: boolean
  number: number
}) {
  const names = new Map(people.map((person) => [person.id, person.name]))
  const choices = [
    ...people,
    ...value.filter((id) => !names.has(id)).map((id) => ({ id, name: id }))
  ]
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          aria-label={translate('tasks.stepPeopleNumber', 'People for step {{number}}', { number })}
        >
          <Users className="size-3.5" />
          <span className="truncate">
            {value.length
              ? value.map((id) => names.get(id) ?? id).join(', ')
              : translate('tasks.stepAddPeople', 'Add people')}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder={translate('tasks.stepFindPeople', 'Find people…')} />
          <CommandList>
            <CommandEmpty>{translate('tasks.stepNoPeople', 'No people available.')}</CommandEmpty>
            {choices.map((person) => {
              const selected = value.includes(person.id)
              return (
                <CommandItem
                  key={person.id}
                  value={`${person.name} ${person.id}`}
                  aria-selected={selected}
                  disabled={!selected && value.length >= 100}
                  onSelect={() =>
                    onChange(
                      selected ? value.filter((id) => id !== person.id) : [...value, person.id]
                    )
                  }
                >
                  <Check className={selected ? 'size-3.5' : 'size-3.5 opacity-0'} />
                  {person.name}
                </CommandItem>
              )
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
