import { CompaniesRequestError } from '@/components/companies/companies-client'
import { translate } from '@/i18n/i18n'
import type { ConsoleTeamRoutinesApi } from '../../../../../shared/console-team-routines-contract'

export function teamRoutinesApi(): ConsoleTeamRoutinesApi {
  const api = window.api?.consoleTeamRoutines
  if (!api) {
    throw new CompaniesRequestError({
      code: 'capability_unavailable',
      message: translate(
        'teamRoutines.unavailable',
        'Team routines need an updated OmniConsole desktop app.'
      )
    })
  }
  return api
}
