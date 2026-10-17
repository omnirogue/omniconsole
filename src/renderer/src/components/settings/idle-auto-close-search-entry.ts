import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getIdleAutoCloseSearchEntry(): SettingsSearchEntry {
  return {
    title: translate('auto.components.settings.experimental.search.idleAutoClose.title', 'Idle auto-close'),
    description: translate(
      'auto.components.settings.experimental.search.idleAutoClose.description',
      'Puts done agents and background workspaces of idle shells to sleep, and discards hidden browser pages, once they have been idle. Shadow only logs what it would do.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.0d24759f14',
        'experimental'
      ),
      ...translateSearchKeyword('auto.components.settings.experimental.search.idleAutoClose.idle', 'idle'),
      ...translateSearchKeyword('auto.components.settings.experimental.search.idleAutoClose.close', 'close'),
      ...translateSearchKeyword('auto.components.settings.experimental.search.idleAutoClose.sleep', 'sleep'),
      ...translateSearchKeyword('auto.components.settings.experimental.search.idleAutoClose.shell', 'shell'),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.idleAutoClose.browser',
        'browser'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.idleAutoClose.terminal',
        'terminal'
      )
    ]
  }
}
