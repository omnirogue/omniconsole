import { Rows3 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import type { SessionSidebarGroupBy } from '@/lib/session-sidebar-view'
import {
  sessionSidebarViewChoice,
  type SessionSidebarViewChoice
} from '@/lib/session-sidebar-view-choice'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { endSessionFocusDrill } from './use-session-focus-view'

export function sessionGroupByLabel(groupBy: SessionSidebarGroupBy): string {
  switch (groupBy) {
    case 'status':
      return translate('conversations.groupBy.status', 'Status')
    case 'state':
      return translate('conversations.viewPicker.status', 'Status')
    case 'task':
      return translate('conversations.groupBy.task', 'Task')
    case 'request':
      return translate('conversations.groupBy.request', 'Request')
    case 'project':
      return translate('conversations.groupBy.project', 'Project')
    case 'company':
      return translate('conversations.groupBy.company', 'Company')
    case 'computer':
      return translate('conversations.groupBy.computer', 'Computer')
    case 'blocking':
      return translate('conversations.groupBy.blocking', "What's blocking")
  }
}

export function sessionViewChoiceLabel(choice: SessionSidebarViewChoice): string {
  if (choice === 'flat') {
    return translate('conversations.viewPicker.sessions', 'Sessions')
  }
  if (choice === 'focus') {
    return translate('conversations.viewPicker.focus', 'Focus')
  }
  return choice === 'folders'
    ? translate('conversations.viewPicker.folders', 'Folders')
    : sessionGroupByLabel(choice)
}

/** The picker's order: the two layouts, then the Group-by views. */
export const SESSION_VIEW_PICKER_LAYOUTS = ['flat', 'folders', 'focus'] as const
export const SESSION_VIEW_PICKER_LENSES = [
  'state',
  'computer',
  'project',
  'company',
  'request',
  'blocking'
] as const satisfies readonly SessionSidebarViewChoice[]

/**
 * The View picker: Focus (the default), Folders, or a Group-by view, one choice per device. Only
 * the view changes: no session moves folder and nothing is recorded.
 */
export function SessionGroupByMenu(): React.JSX.Element {
  const value = useSessionSidebarView((state) => sessionSidebarViewChoice(state.view))
  const label = translate('conversations.viewPicker.menu', 'View: {{view}}', {
    view: sessionViewChoiceLabel(value)
  })
  const choose = (next: string): void => {
    endSessionFocusDrill()
    useSessionSidebarView.getState().setViewChoice(next as SessionSidebarViewChoice)
  }
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant={
            value === 'flat' || value === 'focus' || value === 'folders' ? 'ghost' : 'secondary'
          }
          size="icon-xs"
          className="text-muted-foreground"
          aria-label={label}
          title={label}
        >
          <Rows3 className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {translate('conversations.viewPicker.title', 'View')}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={value} onValueChange={choose}>
          {SESSION_VIEW_PICKER_LAYOUTS.map((option) => (
            <DropdownMenuRadioItem key={option} value={option}>
              {sessionViewChoiceLabel(option)}
            </DropdownMenuRadioItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            {translate('conversations.groupBy.title', 'Group by')}
          </DropdownMenuLabel>
          {SESSION_VIEW_PICKER_LENSES.map((option) => (
            <DropdownMenuRadioItem key={option} value={option}>
              {sessionViewChoiceLabel(option)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
