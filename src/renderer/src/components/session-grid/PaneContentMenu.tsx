import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { PANE_CONTENT_REGISTRY, paneContentLabel } from '@/lib/pane-content-registry'
import { translate } from '@/i18n/i18n'

export function PaneContentMenu({ onPick }: { onPick: (id: string) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const entries = PANE_CONTENT_REGISTRY.filter((entry) =>
    paneContentLabel(entry).toLowerCase().includes(query.trim().toLowerCase())
  )
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={translate('commandCenter.chooseContent', 'Choose pane content')}
          title={translate('commandCenter.chooseContent', 'Choose pane content')}
        >
          <ChevronDown className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={translate('commandCenter.searchContent', 'Search pane content…')}
          className="h-8"
        />
        <div className="mt-2 max-h-80 overflow-y-auto scrollbar-sleek">
          {(['Sessions', 'Sessions info', 'Work pages', 'Work sections', 'Tools'] as const).map(
            (group) => (
              <div key={group}>
                <p className="px-2 py-1 text-xs font-medium text-muted-foreground">
                  {translate(`commandCenter.group.${group}`, group)}
                </p>
                {entries
                  .filter((entry) => entry.group === group)
                  .map((entry) => {
                    const Icon = entry.icon
                    return (
                      <button
                        key={entry.id}
                        type="button"
                        onClick={() => {
                          onPick(entry.id)
                          setOpen(false)
                        }}
                        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:bg-accent"
                      >
                        <Icon className="size-3.5 shrink-0" />
                        <span>{paneContentLabel(entry)}</span>
                        {entry.mount === 'full-page' ? (
                          <span className="ml-auto text-muted-foreground">
                            {translate('commandCenter.fullPage', 'Opens full page')}
                          </span>
                        ) : null}
                        {entry.mount === 'placeholder' ? (
                          <span className="ml-auto text-muted-foreground">
                            {translate('commandCenter.later', 'Later step')}
                          </span>
                        ) : null}
                      </button>
                    )
                  })}
              </div>
            )
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
