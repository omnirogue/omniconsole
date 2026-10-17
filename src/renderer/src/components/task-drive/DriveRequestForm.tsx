import { useId, useMemo, useState } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useHandoffPeople } from '@/components/next-step/use-handoff-people'
import { searchRoster } from '../../../../shared/team-roster-search'
import type { ConsoleDriveFileRequest } from '../../../../shared/console-drive-contract'
import { translate } from '@/i18n/i18n'

export function DriveRequestForm({
  busy,
  destination,
  onSubmit,
  onCancel
}: {
  busy: boolean
  destination: string
  onSubmit: (
    fields: Pick<ConsoleDriveFileRequest, 'expected_from' | 'pattern' | 'expected_count'>
  ) => void
  onCancel: () => void
}) {
  const { people, reload } = useHandoffPeople()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [personId, setPersonId] = useState('')
  const [pattern, setPattern] = useState('*')
  const [count, setCount] = useState('')
  const id = useId()
  const roster = useMemo(() => (people.phase === 'ready' ? people.value : []), [people])
  const person = roster.find((row) => row.id === personId)
  const found = useMemo(() => searchRoster(roster, query, 50), [roster, query])
  const expectedCount = count.trim() ? Number(count) : undefined
  const countValid =
    expectedCount === undefined ||
    (Number.isInteger(expectedCount) && expectedCount >= 1 && expectedCount <= 10_000)
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (!busy && person && countValid && pattern.trim()) {
          onSubmit({
            expected_from: person.id,
            pattern: pattern.trim(),
            ...(expectedCount === undefined ? {} : { expected_count: expectedCount })
          })
        }
      }}
    >
      <div className="space-y-1">
        <Label htmlFor={`${id}-person`}>
          {translate('auto.components.task.drive.DriveRequestForm.df409eef16', 'From')}
        </Label>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              id={`${id}-person`}
              type="button"
              role="combobox"
              aria-expanded={open}
              variant="outline"
              className="w-full justify-between"
              disabled={busy || people.phase !== 'ready'}
            >
              {person?.name ??
                (people.phase === 'loading'
                  ? translate(
                      'auto.components.task.drive.DriveRequestForm.824d5ac2d7',
                      'Loading people…'
                    )
                  : translate(
                      'auto.components.task.drive.DriveRequestForm.0fc7a5c321',
                      'Choose a person'
                    ))}
              <ChevronsUpDown aria-hidden="true" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="p-0">
            <Command shouldFilter={false}>
              <CommandInput
                autoFocus
                placeholder={translate(
                  'auto.components.task.drive.DriveRequestForm.f98f378394',
                  'Search people…'
                )}
                value={query}
                onValueChange={setQuery}
              />
              <CommandList>
                <CommandEmpty>
                  {translate(
                    'auto.components.task.drive.DriveRequestForm.cfbe89867d',
                    'No matching active person.'
                  )}
                </CommandEmpty>
                {found.people.map((row) => (
                  <CommandItem
                    key={row.id}
                    value={row.id}
                    onSelect={() => {
                      setPersonId(row.id)
                      setOpen(false)
                    }}
                  >
                    {row.id === personId && <Check aria-hidden="true" />}
                    <span>
                      {row.name}
                      <span className="block text-xs text-muted-foreground">{row.id}</span>
                    </span>
                  </CommandItem>
                ))}
              </CommandList>
            </Command>
            {found.total > found.people.length && (
              <p className="p-2 text-xs text-muted-foreground">
                {translate('drive.narrowPeople', 'Search to narrow {{count}} people.', {
                  count: found.total
                })}
              </p>
            )}
          </PopoverContent>
        </Popover>
        {people.phase === 'error' && (
          <p role="alert" className="text-xs text-destructive">
            {people.message}{' '}
            <Button type="button" variant="link" size="xs" onClick={reload}>
              {translate(
                'auto.components.task.drive.DriveRequestForm.43b404c16d',
                'Refresh people'
              )}
            </Button>
          </p>
        )}
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-pattern`}>
          {translate('auto.components.task.drive.DriveRequestForm.6572f3195c', 'File names')}
        </Label>
        <Input
          id={`${id}-pattern`}
          value={pattern}
          maxLength={256}
          disabled={busy}
          onChange={(event) => setPattern(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.task.drive.DriveRequestForm.173e19f997',
            'Use * for all files, or a pattern such as *.mp4.'
          )}
        </p>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-count`}>
          {translate('auto.components.task.drive.DriveRequestForm.7d1c25bec8', 'Number of files')}
        </Label>
        <Input
          id={`${id}-count`}
          inputMode="numeric"
          placeholder={translate('auto.components.task.drive.DriveRequestForm.cc63141785', 'Any')}
          value={count}
          disabled={busy}
          aria-invalid={!countValid}
          onChange={(event) => setCount(event.target.value)}
        />
        {!countValid && (
          <p role="alert" className="text-xs text-destructive">
            {translate(
              'auto.components.task.drive.DriveRequestForm.1198756f94',
              'Enter a whole number from 1 to 10,000.'
            )}
          </p>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {translate(
          'drive.writerAccess',
          '{{person}} gets writer access to the entire project folder, {{destination}}. That access remains after the file request ends. Manage access in Google Drive.',
          {
            person: person?.name ?? translate('drive.selectedPerson', 'The selected person'),
            destination
          }
        )}
      </p>
      <div className="flex gap-2">
        <Button
          size="sm"
          type="submit"
          disabled={busy || !person || !countValid || !pattern.trim()}
        >
          {translate(
            'auto.components.task.drive.DriveRequestForm.99fda9ef33',
            'Share folder and request files'
          )}
        </Button>
        <Button size="sm" type="button" variant="ghost" disabled={busy} onClick={onCancel}>
          {translate('auto.components.task.drive.DriveRequestForm.83d8a03ea3', 'Cancel')}
        </Button>
      </div>
    </form>
  )
}
