import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { officeProjectionBackofficeUrl } from '../integration/store/office-projection-backoffice-url'

export function OfficeProjectionLink({ taskId }: { taskId: string }): React.JSX.Element | null {
  const url = useAppStore((state) => officeProjectionBackofficeUrl(taskId, state))
  if (!url) {
    return null
  }
  return (
    <a
      href={url}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        void window.api.shell.openUrl(url)
      }}
      className="text-xs font-medium text-primary underline underline-offset-4"
    >
      {translate('office.projection.openInOmnios', 'View in omnios')}
    </a>
  )
}
