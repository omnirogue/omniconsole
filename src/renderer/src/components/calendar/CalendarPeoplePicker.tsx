import { useState } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

export type CalendarPerson = { id: string; name: string }

export function CalendarPeoplePicker({
  people,
  selected,
  onChange,
  disabled = false
}: {
  people: readonly CalendarPerson[]
  selected: readonly string[]
  onChange: (ids: string[]) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const names = new Map(people.map((person) => [person.id, person.name]))
  const choices = [
    ...people,
    ...selected.filter((id) => !names.has(id)).map((id) => ({ id, name: id }))
  ]
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={translate('calendar.participants', 'Participants')}
          disabled={disabled}
          className="w-full justify-between font-normal"
        >
          <span className="truncate">
            {selected.length
              ? selected.map((id) => names.get(id) ?? id).join(', ')
              : translate('calendar.addPeople', 'Add people')}
          </span>
          <ChevronsUpDown className="shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <Command>
          <CommandInput placeholder={translate('calendar.searchPeople', 'Search people…')} />
          <CommandList>
            <CommandEmpty>{translate('calendar.noPeople', 'No people found.')}</CommandEmpty>
            {choices.map((person) => (
              <CommandItem
                key={person.id}
                value={`${person.name} ${person.id}`}
                onSelect={() => {
                  onChange(
                    selected.includes(person.id)
                      ? selected.filter((id) => id !== person.id)
                      : [...selected, person.id]
                  )
                }}
              >
                <Check
                  className={cn(
                    'size-4',
                    selected.includes(person.id) ? 'opacity-100' : 'opacity-0'
                  )}
                />
                {person.name}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
