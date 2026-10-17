import { useState } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Command, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import type { RoutineSlackChannel } from '../../../../shared/routine-alert-contract'
import type { AutomationAlertChannel } from '../../../../shared/automation-definition-context'

type Channel = Extract<AutomationAlertChannel, { kind: 'slack-channel' }>
export function RoutineSlackChannelPicker({
  channels,
  selected,
  disabled,
  onChange,
  refresh
}: {
  channels: RoutineSlackChannel[]
  selected: Channel[]
  disabled: boolean
  onChange: (next: Channel[]) => void
  refresh: () => Promise<void>
}) {
  const [query, setQuery] = useState('')
  const toggle = (channel: Channel) => {
    const exists = selected.some((row) => row.channelName === channel.channelName)
    onChange(
      exists
        ? selected.filter((row) => row.channelName !== channel.channelName)
        : [...selected, channel]
    )
  }
  const normalized = query.trim().replace(/^#/, '')
  return (
    <div className="space-y-2">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            role="combobox"
            aria-label={translate('routines.notify.chooseChannels', 'Choose Slack channels')}
            disabled={disabled}
            className="w-full justify-between"
          >
            {translate('routines.notify.chooseChannels', 'Choose Slack channels')}
            <ChevronsUpDown />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0">
          <Command>
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder={translate('routines.notify.searchChannels', 'Search or type #channel')}
            />
            <CommandList>
              {channels.map((row) => (
                <CommandItem
                  key={row.id}
                  value={row.name}
                  onSelect={() =>
                    toggle({ kind: 'slack-channel', channelId: row.id, channelName: row.name })
                  }
                >
                  {selected.some(
                    (entry) => entry.channelId === row.id || entry.channelName === row.name
                  ) ? (
                    <Check />
                  ) : null}
                  #{row.name}
                </CommandItem>
              ))}
              {normalized &&
              !channels.some((row) => row.name.toLowerCase() === normalized.toLowerCase()) ? (
                <CommandItem
                  value={query}
                  onSelect={() =>
                    toggle({ kind: 'slack-channel', channelId: '', channelName: normalized })
                  }
                >
                  {translate('routines.notify.useChannel', 'Use #{{channel}}', {
                    channel: normalized
                  })}
                </CommandItem>
              ) : null}
            </CommandList>
          </Command>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void refresh()
            }}
          >
            {translate('routines.notify.refreshChannels', 'Refresh channels')}
          </Button>
        </PopoverContent>
      </Popover>
      {selected.map((row) => (
        <div key={row.channelName} className="flex items-center justify-between text-xs">
          <span>#{row.channelName}</span>
          <Button disabled={disabled} size="xs" variant="ghost" onClick={() => toggle(row)}>
            {translate('routines.definition.remove', 'Remove')}
          </Button>
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        {translate(
          'routines.notify.channelAccess',
          'Channels must be available to your company account. Typed names are checked when sending.'
        )}
      </p>
    </div>
  )
}
