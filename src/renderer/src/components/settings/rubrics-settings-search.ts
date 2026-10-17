import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export const getRubricsSettingsSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('rubrics.settings.library', 'Rubric library'),
    description: translate(
      'rubrics.settings.description',
      'Browse built-in rubrics and manage custom rubrics saved by you or agents for JEV and workflows.'
    ),
    keywords: [
      ...translateSearchKeyword('rubrics.settings.keywordJev', 'JEV'),
      ...translateSearchKeyword('rubrics.settings.keywordRubrics', 'rubrics'),
      ...translateSearchKeyword('rubrics.settings.keywordCustom', 'custom'),
      ...translateSearchKeyword('rubrics.settings.keywordAgents', 'agent-created'),
      ...translateSearchKeyword('rubrics.settings.keywordInstructions', 'instructions')
    ]
  }
])
