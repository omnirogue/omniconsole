import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { resolveBackofficeBaseUrl } from '../../../../shared/backoffice-connection'
import type { TaskFiling } from './use-task-draft'

type Props = {
  session: SidebarSession | null
  open?: boolean
  initialFiling?: TaskFiling
  onOpenChange: (open: boolean) => void
  onCreated?: (taskId: string) => void
}

export function CreateTaskDialog({ session, open, onOpenChange }: Props): React.JSX.Element | null {
  const settings = useAppStore((state) => state.settings)
  const connection = resolveBackofficeBaseUrl(settings ?? {})
  const [error, setError] = useState('')
  const changeOpen = (next: boolean) => {
    if (!next) {
      setError('')
    }
    onOpenChange(next)
  }
  if (!(open ?? session !== null)) {
    return null
  }
  const openJira = async () => {
    if (!connection.configured) {
      return
    }
    setError('')
    try {
      await window.api.shell.openUrl(new URL('/work/jira', connection.baseUrl).toString())
      changeOpen(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }
  return (
    <Dialog open onOpenChange={changeOpen}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{translate('tasks.jiraCaptureTitle', 'Tasks now live in Jira')}</DialogTitle>
          <DialogDescription>
            {translate(
              'tasks.jiraCaptureWhy',
              'Capture a shared commitment in Jira when it needs tracking. Sessions and Handoffs can stay taskless; opening Jira does not create a task or attach this session.'
            )}
          </DialogDescription>
        </DialogHeader>
        {(!connection.configured || error) && (
          <p role="alert" className="text-xs text-destructive">
            {error || (!connection.configured ? connection.message : '')}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => changeOpen(false)}>
            {translate('common.cancel', 'Cancel')}
          </Button>
          <Button disabled={!connection.configured} onClick={() => void openJira()}>
            {translate('tasks.openJiraTasks', 'Open Jira tasks')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
