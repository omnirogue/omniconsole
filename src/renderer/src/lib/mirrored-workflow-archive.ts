import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { SidebarSession } from './sidebar-sessions'

/** A paired controller's workflow its own computer archived: read-only here (step 9). */
export function isArchivedOnController(session: Pick<SidebarSession, 'mirroredWorkflow'>): boolean {
  return session.mirroredWorkflow?.archivedByOwner === true
}

/** Unarchiving here cannot change the controller's mark, so it says where to do it. */
export function noteArchivedOnController(session: Pick<SidebarSession, 'mirroredWorkflow'>): void {
  const environmentId = session.mirroredWorkflow?.environmentId
  const host = useAppStore
    .getState()
    .runtimeEnvironments?.find((environment) => environment.id === environmentId)?.name
  toast.info(
    host
      ? translate(
          'conversations.mirroredWorkflowArchivedOn',
          'Archived on {{host}}. Unarchive it on that computer.',
          { host }
        )
      : translate(
          'conversations.mirroredWorkflowArchivedOnController',
          'Archived on the computer that runs it. Unarchive it there.'
        )
  )
}
