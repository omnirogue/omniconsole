import { translate } from '@/i18n/i18n'
import type { SettingsSearchEntry } from './settings-search'
import { translateSearchKeyword } from './settings-search-keywords'

export function getCommandCenterExperimentalSearchEntry(): SettingsSearchEntry {
  return {
    title: translate('commandCenter.setting.title', 'Attention View command center'),
    description: translate(
      'commandCenter.setting.description',
      'Open Work and startup in the customizable Attention View. Work home remains available under Work.'
    ),
    keywords: translateSearchKeyword(
      'commandCenter.setting.keywords',
      'experimental, grid, panes, layout, startup, home'
    )
  }
}
