import { ConnectorsPane } from './ConnectorsPane'
import { SettingsSection } from './SettingsSection'
import type { SettingsRenderContext } from './settings-render-context'
import { translate } from '@/i18n/i18n'

export function renderConnectorsSettingsSection({
  navigation,
  view
}: SettingsRenderContext): React.JSX.Element {
  return (
    <SettingsSection
      id="connectors"
      title={translate('connectors.title', 'Connectors')}
      description={translate(
        'connectors.description',
        'Connect MCP servers to your agent accounts.'
      )}
      searchEntries={navigation.getSectionSearchEntries('connectors')}
      bodyClassName="rounded-none border-0 bg-transparent p-0 shadow-none"
    >
      {view.isSectionMounted('connectors') ? <ConnectorsPane /> : null}
    </SettingsSection>
  )
}
