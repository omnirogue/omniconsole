import { Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'

/** "3 selected · 2 folders": how much the bulk bar acts on, with picked folders called out. */
export function SessionBulkSelectedCount({
  busy,
  rows,
  folders
}: {
  busy: boolean
  rows: number
  folders: number
}): React.JSX.Element {
  return (
    <span className="flex items-center gap-1.5 tabular-nums">
      {busy ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
      {translate('conversations.selectedCount', '{{count}} selected', { count: rows + folders })}
      {folders > 0 ? (
        <span className="font-normal text-muted-foreground">
          {translate('conversations.foldersSelectedCount', '{{count}} folders', {
            count: folders
          })}
        </span>
      ) : null}
    </span>
  )
}
