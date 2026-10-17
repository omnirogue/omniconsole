import { File, Folder, UserRound, Bot } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { foldPersonName } from '../../../../shared/team-roster-search'
import type { ChatRecipient } from '../../../../shared/chat-delivery'

export type ChatTagOption = {
  id: string
  label: string
  detail?: string
  recipient?: ChatRecipient
  kind: 'person' | 'agent' | 'file' | 'folder' | 'reference'
}

export function filterChatTagOptions(options: ChatTagOption[], query: string): ChatTagOption[] {
  const search = foldPersonName(query)
  return options.filter(
    (option) =>
      option.kind === 'file' ||
      option.kind === 'folder' ||
      option.kind === 'reference' ||
      foldPersonName(`${option.label} ${option.detail ?? ''}`).includes(search)
  )
}

export function ChatRecipientPicker({
  options,
  activeIndex,
  listboxId,
  error,
  loading,
  onChoose
}: {
  options: ChatTagOption[]
  activeIndex: number
  listboxId: string
  error?: string
  loading?: boolean
  onChoose: (option: ChatTagOption) => void
}) {
  return (
    <div
      id={listboxId}
      role="listbox"
      aria-label={translate('chatDelivery.tagRecipient', 'Tag a person, agent, or file')}
      className="scrollbar-sleek absolute bottom-full left-0 right-0 z-20 mb-1 max-h-72 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-floating"
    >
      {loading && (
        <p className="px-2 py-1 text-xs text-muted-foreground">
          {translate('chatDelivery.loadingPeople', 'Loading recipients…')}
        </p>
      )}
      {error && (
        <p role="status" className="px-2 py-1 text-xs text-muted-foreground">
          {error}
        </p>
      )}
      {!loading && options.length === 0 && (
        <p className="px-2 py-1 text-xs text-muted-foreground">
          {translate(
            'chatDelivery.noRecipients',
            'No matching recipients. Choose a name from the directory to send.'
          )}
        </p>
      )}
      {options.map((option, index) => {
        const Icon =
          option.kind === 'person'
            ? UserRound
            : option.kind === 'agent'
              ? Bot
              : option.kind === 'folder'
                ? Folder
                : File
        return (
          <button
            type="button"
            role="option"
            key={option.id}
            id={`${listboxId}-option-${index}`}
            aria-selected={index === activeIndex}
            onPointerDown={(event) => {
              event.preventDefault()
              onChoose(option)
            }}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground',
              index === activeIndex && 'bg-accent text-accent-foreground'
            )}
          >
            <Icon className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{option.label}</span>
              {option.detail && (
                <span className="block truncate text-xs text-muted-foreground">
                  {option.detail}
                </span>
              )}
            </span>
            <span className="text-xs text-muted-foreground">
              {option.kind === 'person'
                ? translate('chatDelivery.person', 'Person')
                : option.kind === 'agent'
                  ? translate('chatDelivery.agent', 'Agent')
                  : option.kind === 'reference'
                    ? translate('chatDelivery.fileReference', 'File reference')
                    : ''}
            </span>
          </button>
        )
      })}
    </div>
  )
}
