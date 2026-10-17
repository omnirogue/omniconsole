import { useRef, useState } from 'react'
import type { Automation } from '../../../../../shared/automations-types'
import { AutomationDeleteDialog } from '@/components/automations/AutomationDeleteDialogs'
import { persistSkipDeleteAutomationConfirm } from '@/components/automations/automation-delete-confirm-preference'
import { useAppStore } from '@/store'

/** Confirms deleting a routine from its row, honouring the Automations page's "Don't ask again". */
export function RoutineDeleteDialog({
  automation,
  open,
  onOpenChange,
  onConfirm
}: {
  automation: Automation
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}): React.JSX.Element {
  const [dontAskAgain, setDontAskAgain] = useState(false)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const close = (): void => {
    setDontAskAgain(false)
    onOpenChange(false)
  }
  return (
    <AutomationDeleteDialog
      deleteTarget={open ? automation : null}
      dontAskDeleteAgain={dontAskAgain}
      confirmButtonRef={confirmRef}
      onOpenChange={(next) => {
        if (!next) {
          close()
        }
      }}
      onDontAskAgainToggle={() => setDontAskAgain((previous) => !previous)}
      onCancel={close}
      onConfirm={() => {
        if (dontAskAgain) {
          const state = useAppStore.getState()
          persistSkipDeleteAutomationConfirm({
            updateSettings: state.updateSettings,
            openSettingsPage: state.openSettingsPage,
            openSettingsTarget: state.openSettingsTarget
          })
        }
        close()
        onConfirm()
      }}
    />
  )
}

/** True when the person turned the confirmation off in Settings. */
export function skipsRoutineDeleteConfirm(): boolean {
  return Boolean(useAppStore.getState().settings?.skipDeleteAutomationConfirm)
}
