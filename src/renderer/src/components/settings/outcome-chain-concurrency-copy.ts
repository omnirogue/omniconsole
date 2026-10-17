import { translate } from '@/i18n/i18n'
import { searchKeywords } from './settings-search-keywords'

export function getOutcomeChainConcurrencyTitle(): string {
  return translate(
    'auto.components.settings.OrchestrationPane.outcomeChainConcurrencyTitle',
    'Max concurrent agents per outcome chain'
  )
}

export function getOutcomeChainConcurrencyDescription(): string {
  return translate(
    'auto.components.settings.OrchestrationPane.outcomeChainConcurrencyDescription',
    'How many agents one session’s outcomes may run at the same time: reviewers in one round, and outcomes you added that do not depend on each other. Outcomes an agent added still run one at a time. 1 to 8.'
  )
}

export function getOutcomeChainConcurrencySearchKeywords(): string[] {
  return searchKeywords([
    { key: 'auto.components.settings.agents.search.96ba2373b6', fallback: 'agent' },
    { key: 'auto.components.settings.orchestration.search.741dfc03fa', fallback: 'worker' },
    {
      key: 'auto.components.settings.orchestration.search.outcomeChainParallel',
      fallback: 'parallel'
    },
    {
      key: 'auto.components.settings.orchestration.search.outcomeChainConcurrent',
      fallback: 'concurrent'
    },
    {
      key: 'auto.components.settings.orchestration.search.outcomeChainReviewers',
      fallback: 'reviewers'
    }
  ])
}
