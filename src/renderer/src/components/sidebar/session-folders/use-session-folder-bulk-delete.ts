import { useCallback, useContext } from 'react'
import { toast } from 'sonner'
import { ConfirmationDialogContext } from '@/components/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSelection } from '@/store/session-selection'
import {
  deleteSessionFoldersByPerson,
  sessionFolderBulkDeleteCopy,
  sessionFolderBulkDeletePlan
} from './session-folder-bulk-delete'

/**
 * The bulk bar's Delete over sessions and picked folders. Folders always ask first (the dialog
 * says where their sessions go); sessions alone keep their one-click delete.
 */
export function useSessionFolderBulkDelete(): (args: {
  folderIds: readonly string[]
  /** View keys of the selected rows the same click deletes. */
  sessionKeys: readonly string[]
  /** Deletes the selected rows; false when the person declined (e.g. stopping a working one). */
  deleteSessions: () => Promise<boolean>
  onBusy: (busy: boolean) => void
}) => Promise<void> {
  // Why the raw context: without the dialog provider (tests, previews) folders are never deleted unasked.
  const confirm = useContext(ConfirmationDialogContext)
  return useCallback(
    async ({ folderIds, sessionKeys, deleteSessions, onBusy }) => {
      // Why live membership: the dialog counts the sessions that will actually move up.
      const plan = sessionFolderBulkDeletePlan(
        useSessionFolders.getState().metadata,
        folderIds,
        new Set(sessionKeys)
      )
      if (
        plan.topIds.length > 0 &&
        !(await confirm?.({
          ...sessionFolderBulkDeleteCopy(plan, sessionKeys.length),
          confirmVariant: 'destructive'
        }))
      ) {
        return
      }
      onBusy(true)
      try {
        if ((sessionKeys.length > 0 && !(await deleteSessions())) || plan.topIds.length === 0) {
          return
        }
        const deleted = deleteSessionFoldersByPerson(plan)
        useSessionSelection.getState().clearFolders()
        if (deleted.length === 0) {
          toast.error(
            useSessionFolders.getState().error ??
              translate('conversations.deleteFailed', 'Could not save the deletion. Try again.')
          )
          return
        }
        toast.success(
          translate(
            'conversations.bulkDeletedFolders',
            'Deleted {{count}} folders. Their sessions were kept.',
            { count: plan.topIds.length }
          )
        )
      } finally {
        onBusy(false)
      }
    },
    [confirm]
  )
}
