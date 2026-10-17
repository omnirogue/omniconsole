import { Eye, EyeOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { SessionFolder } from '@/lib/session-folders'
import { useSessionGroupFocus } from '@/store/session-group-focus'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { savedSessionGroupKeys } from './use-session-group-select'

/** Saved Sessions' eye: on opens every saved folder so all their sessions show; off folds them. */
export function SavedShowAllButton({
  folders
}: {
  folders: readonly SessionFolder[]
}): React.JSX.Element {
  const on = useSessionSidebarView((state) => state.view.savedShowAll === true)
  const label = on
    ? translate('conversations.savedShowFoldersOnly', 'Show folders only in Saved Sessions')
    : translate('conversations.savedShowAll', 'Show every session in Saved Sessions')
  const Icon = on ? Eye : EyeOff
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      aria-pressed={on}
      title={label}
      data-saved-show-all={on ? 'on' : 'off'}
      className={on ? 'text-foreground' : 'text-muted-foreground'}
      onClick={() => {
        const keys = savedSessionGroupKeys(folders)
        // Why: a folder folded down to the conversation in use lists everything again.
        if (!on) {
          keys.forEach((key) => useSessionGroupFocus.getState().showAll(key))
        }
        useSessionSidebarView.getState().setSavedShowAll(!on, keys)
      }}
    >
      <Icon className="size-3.5" />
    </Button>
  )
}
