import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { activateSidebarSession } from './activate-sidebar-session'
import type { SidebarSession } from './sidebar-sessions'

export function openSidebarSession(session: SidebarSession): void {
  void activateSidebarSession(session)
    .then((opened) => {
      if (!opened) {
        toast.error(
          translate(
            'auto.components.SessionSidebar.openFailedDetailed',
            'This session could not be opened. Check its workspace connection and try again.'
          )
        )
      }
    })
    .catch(() =>
      toast.error(
        translate('auto.components.SessionSidebar.openFailed', 'This session could not be opened.')
      )
    )
}
