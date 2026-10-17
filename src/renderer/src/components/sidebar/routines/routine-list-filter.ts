import type { Automation } from '../../../../../shared/automations-types'
import { automationListSearchFieldsMatch } from '@/components/automations/automation-list-search'

export function routineMatchesQuery(
  automation: Pick<Automation, 'name' | 'prompt'>,
  query: string
): boolean {
  return automationListSearchFieldsMatch({ ...automation, project: '' }, query)
}
