import { useCallback } from 'react'
import { translate } from '@/i18n/i18n'
import { handoffApi } from '@/components/handoffs/handoff-client'
import { useHandoffScope } from '@/components/handoffs/handoff-scope'
import {
  companiesApi,
  companiesErrorMessage,
  useCompaniesRead
} from '@/components/companies/companies-client'
import { useWorkFolders } from '@/components/companies/use-work-folders'
import type { ConsoleWorkflowResult } from '../../../../shared/console-workflow-types'
import type { TeamRosterPerson } from '../../../../shared/team-roster-search'
import { filterHandoffPeople, handoffPeopleMayBeIncomplete } from './handoff-people'
import type { NextStepLoad } from './use-next-step-recipients'

// Why: the menu opens on hover; the roster and /me must not cost a round trip per hover — but a
// person who left must drop out within a minute, not at the next app restart.
export const HANDOFF_PEOPLE_READ_TTL_MS = 60_000
const reads = new Map<string, { at: number; pending: Promise<ConsoleWorkflowResult<unknown>> }>()

/** Tests and a signed-person change start from an empty cache. */
export function resetHandoffPeopleReads(): void {
  reads.clear()
}

export function cachedHandoffRead<T>(
  key: string,
  read: () => Promise<ConsoleWorkflowResult<T>>,
  now: number = Date.now()
): Promise<ConsoleWorkflowResult<T>> {
  const entry = reads.get(key)
  if (entry && now - entry.at < HANDOFF_PEOPLE_READ_TTL_MS) {
    return entry.pending as Promise<ConsoleWorkflowResult<T>>
  }
  const pending = read().then((response) => {
    if (!response.ok) {
      reads.delete(key)
    }
    return response
  })
  reads.set(key, { at: now, pending })
  return pending
}

function useScopedRead<T>(
  name: string,
  read: () => Promise<ConsoleWorkflowResult<T>>,
  scope: string
) {
  const key = `${name}:${scope}`
  const result = useCompaniesRead(async () => {
    const response = await cachedHandoffRead(key, read)
    return response.ok ? { ...response, data: { scope, value: response.data } } : response
  }, scope)
  const innerReload = result.reload
  const reload = useCallback(() => {
    reads.delete(key)
    innerReload()
  }, [innerReload, key])
  return { ...result, reload, data: result.data?.scope === scope ? result.data.value : null }
}

export function useHandoffPeople() {
  const scope = useHandoffScope()
  const roster = useScopedRead('roster', () => handoffApi().recipients(), scope)
  const me = useScopedRead('me', () => companiesApi().me(), scope)
  const folders = useWorkFolders(scope)
  const serverScoped = Boolean(
    roster.data && 'peopleSource' in roster.data && roster.data.peopleSource === 'directory'
  )
  // Why: the admin users list is the same sign-in directory, just read through the admin door.
  const peopleSource: 'directory' | 'employees' =
    roster.data &&
    'peopleSource' in roster.data &&
    (roster.data.peopleSource === 'directory' || roster.data.peopleSource === 'admin-directory')
      ? 'directory'
      : 'employees'
  const knownFolders = folders.error ? null : folders.data
  let people: NextStepLoad<TeamRosterPerson[]>
  if (roster.error || me.error) {
    people = { phase: 'error', message: companiesErrorMessage(roster.error || me.error) }
  } else if (!roster.data || !me.data || (!serverScoped && folders.loading)) {
    people = { phase: 'loading' }
  } else if (me.data.ok === false) {
    people = {
      phase: 'error',
      message:
        me.data.reason ??
        translate('nextStep.peopleSignInRequired', 'Sign in to load your teammates.')
    }
  } else if (!me.data.user?.employee_id) {
    people = {
      phase: 'error',
      message: translate(
        'nextStep.peopleEmployeeRequired',
        'Your account needs an employee profile before you can hand off work. Ask an admin to link it, then refresh people.'
      )
    }
  } else {
    people = {
      phase: 'ready',
      value: filterHandoffPeople({
        roster: roster.data.employees,
        serverScoped,
        me: {
          employee_id: me.data.user?.employee_id,
          role: me.data.user?.role,
          company_scope: me.data.company_scope === 'all' ? 'all' : (me.data.companies ?? [])
        },
        folders: knownFolders
      })
    }
  }
  const reloadRoster = roster.reload
  const reloadMe = me.reload
  const reloadFolders = folders.reload
  const reload = useCallback(() => {
    reloadRoster()
    reloadMe()
    reloadFolders()
  }, [reloadRoster, reloadMe, reloadFolders])
  const peopleIncomplete =
    me.data && me.data.ok !== false
      ? handoffPeopleMayBeIncomplete({
          serverScoped,
          me: {
            company_scope: me.data.company_scope === 'all' ? 'all' : (me.data.companies ?? [])
          },
          folders: knownFolders
        })
      : false
  return {
    people,
    peopleSource,
    peopleIncomplete,
    reload,
    employeeId: me.data?.ok !== false ? (me.data?.user?.employee_id ?? null) : null
  }
}
