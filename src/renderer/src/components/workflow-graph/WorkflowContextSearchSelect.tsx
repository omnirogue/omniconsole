import { useState } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
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

export function WorkflowContextSearchSelect({
  value,
  options,
  onChange,
  label,
  placeholder
}: {
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
  label: string
  placeholder: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          className="h-8 min-w-0 flex-1 justify-between gap-2 text-xs"
        >
          <span className="truncate">
            {options.find((option) => option.value === value)?.label ?? value}
          </span>
          <ChevronsUpDown aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="popover-wheel-scroll flex max-h-[var(--radix-popover-content-available-height)] w-80 max-w-[calc(100vw-2rem)] flex-col p-0"
      >
        <Command className="min-h-0">
          <CommandInput aria-label={placeholder} placeholder={placeholder} />
          <CommandList className="min-h-0 max-h-60">
            <CommandEmpty>
              {translate('workflowGraph.context.noMatches', 'Nothing matches.')}
            </CommandEmpty>
            {options.map((option) => (
              <CommandItem
                key={option.value}
                value={option.label}
                onSelect={() => {
                  onChange(option.value)
                  setOpen(false)
                }}
              >
                <Check
                  aria-hidden="true"
                  className={
                    value === option.value ? 'size-3 shrink-0' : 'size-3 shrink-0 invisible'
                  }
                />
                <span className="break-all">{option.label}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
