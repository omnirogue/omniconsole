import { Check, Palette } from 'lucide-react'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import {
  ownSessionGroupColor,
  SESSION_FOLDER_COLORS,
  sessionFolderColorLabel,
  sessionFolderColorVar
} from '@/lib/session-folder-colors'
import { colorFolderGroupByPerson } from '@/lib/session-organization-person-changes'
import { useSessionSidebarView } from '@/store/session-sidebar-view'

/** "Color" on a folder's menu: its own color, which its subfolders and sessions take on. */
export function SessionFolderColorMenu({ groupKey }: { groupKey: string }): React.JSX.Element {
  const own = useSessionSidebarView((state) => ownSessionGroupColor(state.view, groupKey))
  const setColor = colorFolderGroupByPerson
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Palette className="size-3.5" />
        {translate('conversations.folderColor', 'Color')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-44">
        {SESSION_FOLDER_COLORS.map((color) => (
          <DropdownMenuItem
            key={color}
            data-session-folder-color={color}
            onSelect={() => setColor(groupKey, color)}
          >
            <span
              aria-hidden
              className="size-3 shrink-0 rounded-full"
              style={{ background: sessionFolderColorVar(color) }}
            />
            <span className="flex-1">{sessionFolderColorLabel(color)}</span>
            {own === color ? <Check className="size-3.5" /> : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={own === null} onSelect={() => setColor(groupKey, null)}>
          <span aria-hidden className="size-3 shrink-0 rounded-full border border-border" />
          {translate('conversations.folderColorNone', 'No color')}
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
