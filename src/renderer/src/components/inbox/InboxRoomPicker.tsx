import { useState } from 'react'
import { Check, ChevronsUpDown, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { translate as t } from '@/i18n/i18n'

export type RoomPickerOption = { key: string; title: string; detail: string; disabled?: boolean }
export function InboxRoomPicker({
  label,
  groups,
  selected,
  onChange
}: {
  label: string
  groups: { label: string; options: RoomPickerOption[]; notice?: string; retry?: () => void }[]
  selected: RoomPickerOption[]
  onChange: (keys: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState(0)
  const group = groups[tab] ?? groups[0]
  const toggle = (key: string) =>
    onChange(
      selected.some((item) => item.key === key)
        ? selected.filter((item) => item.key !== key).map((item) => item.key)
        : [...selected.map((item) => item.key), key]
    )
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-label={label}
            aria-expanded={open}
            className="w-full justify-between font-normal"
          >
            {t('inbox.room.choose', 'Choose…')}
            <ChevronsUpDown className="size-4 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="popover-wheel-scroll w-[var(--radix-popover-trigger-width)] p-0"
        >
          {groups.length > 1 && (
            <div
              className="flex gap-1 border-b p-2"
              role="group"
              aria-label={t('inbox.room.contextType', 'Context type')}
            >
              {groups.map((entry, index) => (
                <Button
                  key={entry.label}
                  type="button"
                  size="sm"
                  variant={tab === index ? 'secondary' : 'ghost'}
                  aria-pressed={tab === index}
                  onClick={() => setTab(index)}
                >
                  {entry.label}
                </Button>
              ))}
            </div>
          )}
          <Command key={tab} className="jump-palette">
            <CommandInput placeholder={t('inbox.room.search', 'Search by name…')} />
            <CommandList>
              <CommandEmpty>{t('inbox.room.noMatches', 'No matching records.')}</CommandEmpty>
              {group.options.map((item) => (
                <CommandItem
                  key={item.key}
                  disabled={item.disabled}
                  value={`${item.title} ${item.detail} ${item.key}`}
                  onSelect={() => {
                    toggle(item.key)
                    setOpen(false)
                  }}
                  className="jump-palette-item gap-2"
                >
                  <Check
                    className={`size-4 shrink-0 ${selected.some((value) => value.key === item.key) ? 'opacity-100' : 'opacity-0'}`}
                  />
                  <span className="min-w-0">
                    <span className="block truncate">{item.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {item.detail}
                    </span>
                  </span>
                </CommandItem>
              ))}
            </CommandList>
          </Command>
          {group.notice && (
            <p role="status" className="p-3 text-xs text-muted-foreground">
              {group.notice}
            </p>
          )}
          {group.retry && (
            <Button type="button" variant="ghost" size="sm" onClick={group.retry}>
              {t('inbox.room.reload', 'Reload')}
            </Button>
          )}
        </PopoverContent>
      </Popover>
      {selected.length > 0 && (
        <ul className="space-y-1">
          {selected.map((item) => (
            <li
              key={item.key}
              className="flex items-center justify-between gap-2 rounded-md border px-3 py-1"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm">{item.title}</span>
                <span className="block truncate text-xs text-muted-foreground">{item.detail}</span>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('inbox.room.remove', 'Remove {{name}}', { name: item.title })}
                onClick={() => toggle(item.key)}
              >
                <X className="size-3" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
