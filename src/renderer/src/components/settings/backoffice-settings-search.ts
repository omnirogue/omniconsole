import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getBackofficeSettingsSearchEntries(): SettingsSearchEntry[] {
  return [
    {
      title: translate('auto.components.settings.backoffice.title', 'Backoffice'),
      keywords: [
        ...translateSearchKeyword('backoffice.settingsSearch.keywordBackoffice', 'backoffice'),
        ...translateSearchKeyword('backoffice.settingsSearch.keywordControlPlane', 'control plane'),
        ...translateSearchKeyword('backoffice.settingsSearch.keywordEnvironment', 'environment'),
        ...translateSearchKeyword('backoffice.settingsSearch.keywordLocal', 'local'),
        ...translateSearchKeyword('backoffice.settingsSearch.keywordProduction', 'production'),
        ...translateSearchKeyword('backoffice.settingsSearch.keywordUrl', 'url', {
          englishOnly: true
        }),
        ...translateSearchKeyword('backoffice.settingsSearch.keywordServer', 'server'),
        ...translateSearchKeyword('backoffice.settingsSearch.keywordConnection', 'connection'),
        ...translateSearchKeyword('backoffice.settingsSearch.keywordConsole', 'console')
      ]
    },
    {
      title: translate('auto.components.settings.backoffice.environment', 'Environment'),
      keywords: [
        ...translateSearchKeyword('backoffice.settingsSearch.keywordEnvironment', 'environment'),
        ...translateSearchKeyword('backoffice.settingsSearch.keywordLocal', 'local'),
        ...translateSearchKeyword('backoffice.settingsSearch.keywordProduction', 'production'),
        ...translateSearchKeyword('backoffice.settingsSearch.keywordSwitch', 'switch')
      ]
    },
    {
      title: translate('auto.components.settings.backoffice.urls', 'Server URLs'),
      keywords: [
        ...translateSearchKeyword('backoffice.settingsSearch.keywordUrl', 'url', {
          englishOnly: true
        }),
        ...translateSearchKeyword('backoffice.settingsSearch.keywordAddress', 'address'),
        ...translateSearchKeyword('backoffice.settingsSearch.keywordHttps', 'https', {
          englishOnly: true
        }),
        ...translateSearchKeyword('backoffice.settingsSearch.keywordDomain', 'domain')
      ]
    },
    {
      title: translate('companyFolders.title', 'Company folders'),
      keywords: [
        ...translateSearchKeyword('backoffice.settingsSearch.keywordCompany', 'company'),
        ...translateSearchKeyword('backoffice.settingsSearch.keywordFolder', 'folder'),
        ...translateSearchKeyword('backoffice.settingsSearch.keywordWorkRoot', 'work root'),
        ...translateSearchKeyword('backoffice.settingsSearch.keywordDepartment', 'department')
      ]
    }
  ]
}
