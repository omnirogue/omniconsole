import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import {
  DONE_ARCHIVE_DEFAULT_MINUTES,
  DONE_ARCHIVE_MAX_MINUTES
} from '../../../../../shared/session-done-archive'

const CHOICES = [30, 60, 120, 360, 1440]

export function SessionAutoArchiveOptions(): React.JSX.Element {
  const minutes = useSessionSidebarView(
    (state) => state.view.doneArchiveMinutes ?? DONE_ARCHIVE_DEFAULT_MINUTES
  )
  const setMinutes = useSessionSidebarView((state) => state.setDoneArchiveMinutes)
  const [custom, setCustom] = useState(String(minutes || DONE_ARCHIVE_DEFAULT_MINUTES))
  const value = Number(custom)
  const valid = Number.isInteger(value) && value >= 1 && value <= DONE_ARCHIVE_MAX_MINUTES
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>
        {translate('conversations.doneArchiveTitle', 'Archive completed sessions')}
      </DropdownMenuLabel>
      <p className="px-2 pb-2 text-xs text-muted-foreground">
        {translate(
          'conversations.doneArchiveHelp',
          'After continuously Done, with no bell, question or unfinished work. Saved and pinned sessions stay visible. History is kept; Unarchive keeps a session visible.'
        )}
      </p>
      <DropdownMenuRadioGroup
        value={String(minutes)}
        onValueChange={(next) => setMinutes(Number(next))}
      >
        <DropdownMenuRadioItem value="0">
          {translate('conversations.doneArchiveOff', 'Off')}
        </DropdownMenuRadioItem>
        {CHOICES.map((choice) => (
          <DropdownMenuRadioItem key={choice} value={String(choice)}>
            {choice < 60
              ? translate('conversations.doneArchiveMinutes', 'After {{count}} minutes', {
                  count: choice
                })
              : translate('conversations.doneArchiveHours', 'After {{count}} hr', {
                  count: choice / 60
                })}
          </DropdownMenuRadioItem>
        ))}
        {minutes > 0 && !CHOICES.includes(minutes) && (
          <DropdownMenuRadioItem value={String(minutes)}>
            {translate('conversations.doneArchiveMinutes', 'After {{count}} minutes', {
              count: minutes
            })}
          </DropdownMenuRadioItem>
        )}
      </DropdownMenuRadioGroup>
      <form
        className="flex items-center gap-2 p-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (valid) {
            setMinutes(value)
          }
        }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <Input
          type="number"
          min={1}
          max={DONE_ARCHIVE_MAX_MINUTES}
          step={1}
          value={custom}
          aria-label={translate(
            'conversations.doneArchiveCustom',
            'Custom archive delay in minutes'
          )}
          onChange={(event) => setCustom(event.target.value)}
          className="h-7 min-w-0"
        />
        <span className="text-xs text-muted-foreground">
          {translate('conversations.doneArchiveUnit', 'min')}
        </span>
        <Button type="submit" variant="outline" size="sm" disabled={!valid}>
          {translate('conversations.doneArchiveSet', 'Set')}
        </Button>
      </form>
    </>
  )
}
