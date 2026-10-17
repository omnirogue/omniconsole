import { translate } from '@/i18n/i18n'
import type { SettingsSearchEntry } from './settings-search'
import { translateSearchKeyword } from './settings-search-keywords'

export function getBrowserCleanupSearchEntry(): SettingsSearchEntry {
  return {
    title: translate('browser.cleanup.title', 'Clean up browser pages'),
    description: translate(
      'browser.cleanup.description',
      'Review pages on this computer and close those you no longer need.'
    ),
    keywords: [
      ...translateSearchKeyword('browser.cleanup.searchMemory', 'memory'),
      ...translateSearchKeyword('browser.cleanup.searchCleanup', 'cleanup'),
      ...translateSearchKeyword('browser.cleanup.searchClose', 'close'),
      ...translateSearchKeyword('browser.cleanup.searchPages', 'pages')
    ],
    targetSectionId: 'browser-cleanup'
  }
}
