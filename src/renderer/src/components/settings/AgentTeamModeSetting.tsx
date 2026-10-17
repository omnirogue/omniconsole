import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import {
  SettingsRow,
  SettingsSegmentedControl,
  SettingsSubsectionHeader
} from './SettingsFormControls'

export function AgentTeamModeSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}): React.JSX.Element {
  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader
        title={translate('conversationLauncher.teamDefaults', 'Claude / Codex launch mode')}
        description={translate(
          'conversationLauncher.teamDescription',
          'Used by the agent picker. Teams delegates independent work; account, model, and effort remain your selections. Applies to new sessions.'
        )}
      />
      {(['claude', 'codex'] as const).map((agent) => (
        <SettingsRow
          key={agent}
          label={
            agent === 'claude'
              ? translate('conversationLauncher.claude', 'Claude')
              : translate('conversationLauncher.codex', 'Codex')
          }
          control={
            <SettingsSegmentedControl
              value={settings.conversationLaunchDefaults?.[agent]?.team ? 'team' : 'single'}
              ariaLabel={
                agent === 'claude'
                  ? translate('conversationLauncher.claudeLaunchMode', 'Claude launch mode')
                  : translate('conversationLauncher.codexLaunchMode', 'Codex launch mode')
              }
              options={[
                {
                  value: 'single',
                  label: translate('conversationLauncher.singleAgent', 'Single agent')
                },
                { value: 'team', label: translate('conversationLauncher.teams', 'Teams') }
              ]}
              onChange={(value) => {
                void updateSettings({
                  conversationLaunchDefaults: {
                    ...settings.conversationLaunchDefaults,
                    [agent]: {
                      ...settings.conversationLaunchDefaults?.[agent],
                      team: value === 'team'
                    }
                  }
                })
              }}
            />
          }
        />
      ))}
    </section>
  )
}
