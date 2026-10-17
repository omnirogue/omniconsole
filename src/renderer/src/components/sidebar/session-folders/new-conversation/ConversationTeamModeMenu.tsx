import { useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import {
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'

export function ConversationTeamModeMenu({
  agent
}: {
  agent: 'claude' | 'codex'
}): React.JSX.Element {
  const team = useAppStore(
    (state) => state.settings?.conversationLaunchDefaults?.[agent]?.team === true
  )
  const [saving, setSaving] = useState(false)
  const save = async (team: boolean): Promise<void> => {
    setSaving(true)
    try {
      const state = useAppStore.getState()
      await state.updateSettingsOrThrow({
        conversationLaunchDefaults: {
          ...state.settings?.conversationLaunchDefaults,
          [agent]: { ...state.settings?.conversationLaunchDefaults?.[agent], team }
        }
      })
    } catch {
      toast.error(translate('conversationLauncher.saveFailed', 'Could not save launch defaults.'))
    } finally {
      setSaving(false)
    }
  }
  return (
    <>
      <DropdownMenuLabel>{translate('conversationLauncher.mode', 'Launch mode')}</DropdownMenuLabel>
      {[false, true].map((value) => (
        <DropdownMenuCheckboxItem
          key={String(value)}
          checked={team === value}
          disabled={saving}
          onSelect={(event) => event.preventDefault()}
          onCheckedChange={() => void save(value)}
        >
          {value
            ? translate('conversationLauncher.teams', 'Teams')
            : translate('conversationLauncher.singleAgent', 'Single agent')}
        </DropdownMenuCheckboxItem>
      ))}
      <DropdownMenuSeparator />
    </>
  )
}
