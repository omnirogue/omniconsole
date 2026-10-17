import { useMemo, useState } from 'react'
import { Tags } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useSessionTags } from '@/store/session-tags'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { conversationViewKey } from '@/lib/conversation-view'
import { tagSessionsByPerson } from '@/lib/session-organization-person-changes'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useSessionTagIds } from './use-session-tags'

export function SessionTagPicker({
  sessions,
  filter = false,
  iconOnly = false
}: {
  sessions: readonly SidebarSession[]
  filter?: boolean
  /** A row's own picker: the icon alone, named by its tooltip, like the row's other controls. */
  iconOnly?: boolean
}) {
  const store = useSessionTags()
  const ids = useSessionTagIds(sessions)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const keys = useMemo(() => sessions.map(conversationViewKey), [sessions])
  const label = filter
    ? translate('sessionTags.filter', 'Filter by tags')
    : sessions.length === 1
      ? translate('sessionTags.title', 'Tags')
      : translate('sessionTags.edit', 'Tag selected')
  const trigger = (
    <PopoverTrigger asChild>
      <Button
        variant={filter && store.data.filter.length ? 'secondary' : 'ghost'}
        size={iconOnly ? 'icon-xs' : 'xs'}
        aria-label={label}
        disabled={!filter && !keys.length}
        className={iconOnly ? undefined : 'gap-1'}
      >
        <Tags className="size-3.5" />
        {iconOnly ? null : filter ? store.data.filter.length || null : label}
      </Button>
    </PopoverTrigger>
  )
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {iconOnly ? (
        <Tooltip>
          <TooltipTrigger asChild>{trigger}</TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
      ) : (
        trigger
      )}
      <PopoverContent align="start" className="w-64 space-y-2 p-3">
        <p className="text-sm font-medium">{label}</p>
        {filter ? (
          <SessionTagFilterPanel
            onManageTags={() => {
              setOpen(false)
              openSessionTagManagement()
            }}
          />
        ) : (
          <>
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={translate('sessionTags.search', 'Find tags…')}
              aria-label={translate('sessionTags.search', 'Find tags…')}
              className="h-8"
            />
            <div className="max-h-56 space-y-1 overflow-y-auto scrollbar-sleek">
              {store.data.tags
                .filter((tag) => tag.name.toLowerCase().includes(query.toLowerCase()))
                .map((tag) => {
                  const count = keys.filter((key) => ids.get(key)?.includes(tag.id)).length
                  const checked = count === keys.length ? true : count ? 'indeterminate' : false
                  return (
                    <label
                      key={tag.id}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1.5 text-sm hover:bg-accent"
                    >
                      <Checkbox
                        checked={checked}
                        disabled={!store.loaded}
                        onCheckedChange={() => {
                          const next = checked !== true
                          // Why one change: the whole selection is one recorded tag with one Undo.
                          tagSessionsByPerson(keys, tag.id, next, {
                            automaticTag: (key) => ids.get(key)?.[0] ?? null
                          })
                        }}
                      />
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: tag.color }}
                      />
                      <span className="truncate">{tag.name}</span>
                    </label>
                  )
                })}
            </div>
            {store.error ? (
              <p role="alert" className="text-xs text-destructive">
                {store.error}
              </p>
            ) : null}
            <div className="flex justify-end border-t pt-2">
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  setOpen(false)
                  openSessionTagManagement()
                }}
              >
                {translate('sessionTags.manage', 'Manage tags')}
              </Button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

function openSessionTagManagement(): void {
  useAppStore.getState().openSettingsTarget({
    pane: 'session-tags',
    repoId: null,
    sectionId: 'session-tags'
  })
  useAppStore.getState().openSettingsPage()
}

/**
 * The filter checklist alone (search, tags, clear, manage), with no Popover of its own — shared
 * by the row-level filter picker and the toolbar's combined Filter menu.
 */
export function SessionTagFilterPanel({
  onManageTags
}: {
  onManageTags: () => void
}): React.JSX.Element {
  const store = useSessionTags()
  const [query, setQuery] = useState('')
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {translate('sessionTags.any', 'Show sessions with any selected tag.')}
      </p>
      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={translate('sessionTags.search', 'Find tags…')}
        aria-label={translate('sessionTags.search', 'Find tags…')}
        className="h-8"
      />
      <div className="max-h-56 space-y-1 overflow-y-auto scrollbar-sleek">
        {store.data.tags
          .filter((tag) => tag.name.toLowerCase().includes(query.toLowerCase()))
          .map((tag) => {
            const checked = store.data.filter.includes(tag.id)
            return (
              <label
                key={tag.id}
                className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1.5 text-sm hover:bg-accent"
              >
                <Checkbox
                  checked={checked}
                  disabled={!store.loaded}
                  onCheckedChange={() => {
                    const next = !checked
                    store.setFilter(
                      next
                        ? [...store.data.filter, tag.id]
                        : store.data.filter.filter((id) => id !== tag.id)
                    )
                  }}
                />
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: tag.color }}
                />
                <span className="truncate">{tag.name}</span>
              </label>
            )
          })}
      </div>
      {store.error ? (
        <p role="alert" className="text-xs text-destructive">
          {store.error}
        </p>
      ) : null}
      <div className="flex justify-between border-t pt-2">
        <Button
          variant="ghost"
          size="xs"
          disabled={!store.loaded || !store.data.filter.length}
          onClick={() => store.setFilter([])}
        >
          {translate('sessionTags.clear', 'Clear filters')}
        </Button>
        <Button variant="ghost" size="xs" onClick={onManageTags}>
          {translate('sessionTags.manage', 'Manage tags')}
        </Button>
      </div>
    </div>
  )
}
