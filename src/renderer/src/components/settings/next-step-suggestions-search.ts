import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translateSearchKeyword } from './settings-search-keywords'

export const getNextStepSuggestionsSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('nextStepSettings.title', 'Suggested next steps'),
    description: translate(
      'nextStepSettings.description',
      'After each Claude or Codex turn, one read-only model call proposes what to do next. Nothing runs until you click.'
    ),
    keywords: [
      ...translateSearchKeyword('nextStepSettings.keywords.nextSteps', 'next steps'),
      ...translateSearchKeyword('nextStepSettings.keywords.suggestions', 'suggestions'),
      ...translateSearchKeyword('nextStepSettings.keywords.suggest', 'suggest'),
      ...translateSearchKeyword('nextStepSettings.keywords.ai', 'ai'),
      ...translateSearchKeyword('nextStepSettings.keywords.agent', 'agent'),
      ...translateSearchKeyword('nextStepSettings.keywords.model', 'model')
    ]
  }
])
