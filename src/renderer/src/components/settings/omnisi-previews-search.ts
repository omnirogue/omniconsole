import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getOmniSiPreviewsSearchEntry = createLocalizedCatalog((): SettingsSearchEntry => ({
  title: translate('auto.components.settings.omniSiPreviews.search.title', 'OmniSI previews'),
  description: translate(
    'auto.components.settings.omniSiPreviews.search.description',
    'Shows OmniSI panels whose service or data is not live yet: Model Arena, Brand Kits, Assets, Spend Guard, the chat prompt cost badge, and the Evolve quality-cost and judge audit views.'
  ),
  keywords: [
    ...translateSearchKeyword(
      'auto.components.settings.experimental.search.0d24759f14',
      'experimental'
    ),
    ...translateSearchKeyword(
      'auto.components.settings.omniSiPreviews.search.keywordOmniSi',
      'omnisi'
    ),
    ...translateSearchKeyword(
      'auto.components.settings.omniSiPreviews.search.keywordArena',
      'arena'
    ),
    ...translateSearchKeyword(
      'auto.components.settings.omniSiPreviews.search.keywordBrandKit',
      'brand kit'
    ),
    ...translateSearchKeyword(
      'auto.components.settings.omniSiPreviews.search.keywordSpend',
      'spend'
    )
  ],
  targetSectionId: 'omnisi-previews'
}))
