import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

/** The folder store's load or save error, with Retry while nothing has loaded yet. */
export function SessionFolderLoadError({
  folders
}: {
  folders: { error: string | null; loaded: boolean; load: () => void }
}): React.JSX.Element | null {
  if (!folders.error) {
    return null
  }
  return (
    <div role="alert" className="text-xs text-destructive">
      {folders.error}
      {!folders.loaded ? (
        <Button variant="ghost" size="xs" onClick={folders.load}>
          {translate('auto.components.SessionSidebar.retry', 'Retry')}
        </Button>
      ) : null}
    </div>
  )
}
