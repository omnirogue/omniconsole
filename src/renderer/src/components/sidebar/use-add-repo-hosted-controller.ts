import { useCallback, useMemo } from 'react'
import { useAppStore } from '@/store'
import { markOnboardingProjectAdded } from '@/lib/onboarding-project-checklist'

/** Contract a host surface (e.g. the workspace composer modal) passes to
 *  AddRepoDialog to nest it as a layered dialog instead of the store modal. */
export type AddRepoDialogHostedController = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after a Git project is added; the host selects the new project
   *  instead of running the default-checkout navigation handoff. */
  onProjectAdded: (repoId: string) => void | Promise<void>
  /** Radix close-autofocus hook for the nested dialog. Lets the host redirect
   *  focus (e.g. to the composer's name field) instead of Radix restoring it
   *  to the already-unmounted combobox row that opened the dialog. */
  onCloseAutoFocus?: (event: Event) => void
  /** Closes the host surface when an outcome navigates away (folder workspace,
   *  non-git confirm modal, SSH settings). Defaults to the store modal slot,
   *  which is right for the workspace composer but a no-op for a host that
   *  lives elsewhere, such as the Project settings dialog. */
  closeHost?: () => void
}

export function useAddRepoHostedController(hosted: AddRepoDialogHostedController | undefined): {
  closeModal: () => void
  /** Close for folder/non-git outcomes, which end in folder-workspace
   *  activation (or the confirm-non-git-folder store modal) instead of a
   *  composer selection. Hosted mode must close the composer too — leaving it
   *  open would hide the navigation behind a stale project selection. */
  closeForFolderHandoff: () => void
  finishProjectAdd: ((repoId: string) => Promise<void>) | undefined
  handleOpenSshSettings: () => void
} {
  const storeCloseModal = useAppStore((s) => s.closeModal)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const hostedOnOpenChange = hosted?.onOpenChange
  const hostedOnProjectAdded = hosted?.onProjectAdded
  const closeHost = hosted?.closeHost ?? storeCloseModal
  // Why: hosted mode (nested inside the workspace composer) must close only
  // this dialog, never the composer modal that lives in the activeModal slot.
  const closeModal = useMemo(
    () => (hostedOnOpenChange ? () => hostedOnOpenChange(false) : storeCloseModal),
    [hostedOnOpenChange, storeCloseModal]
  )
  const finishProjectAdd = useMemo(
    () =>
      hostedOnOpenChange && hostedOnProjectAdded
        ? async (repoId: string): Promise<void> => {
            await markOnboardingProjectAdded('addedRepo')
            hostedOnOpenChange(false)
            await hostedOnProjectAdded(repoId)
          }
        : undefined,
    [hostedOnOpenChange, hostedOnProjectAdded]
  )
  const closeForFolderHandoff = useMemo(
    () =>
      hostedOnOpenChange
        ? () => {
            hostedOnOpenChange(false)
            closeHost()
          }
        : storeCloseModal,
    [closeHost, hostedOnOpenChange, storeCloseModal]
  )
  const handleOpenSshSettings = useCallback((): void => {
    closeModal()
    // Why: Settings is a full page; in hosted mode the composer modal in the
    // activeModal slot would otherwise stay open on top of it.
    if (hostedOnOpenChange) {
      closeHost()
    }
    openSettingsTarget({ pane: 'ssh', repoId: null, sectionId: 'ssh' })
    openSettingsPage()
  }, [closeHost, closeModal, hostedOnOpenChange, openSettingsPage, openSettingsTarget])
  return { closeModal, closeForFolderHandoff, finishProjectAdd, handleOpenSshSettings }
}
