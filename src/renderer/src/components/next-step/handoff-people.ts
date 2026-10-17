import type { TeamRosterPerson } from '../../../../shared/team-roster-search'
import type { WorkFolders } from '../../../../shared/console-work-folders-contract'

export type HandoffPerson = TeamRosterPerson & { companies?: string[] | null }
export function filterHandoffPeople(input: {
  roster: readonly HandoffPerson[]
  me: {
    employee_id?: string | null
    company_scope: 'all' | readonly string[]
    role?: string | null
  }
  folders: WorkFolders | null
  serverScoped?: boolean
}): TeamRosterPerson[] {
  const { roster, me, folders } = input
  // Why: /work/recipients already authorizes its directory, including people without company grants.
  if (input.serverScoped) {
    return [...roster]
  }
  const scope = new Set(me.company_scope === 'all' ? [] : me.company_scope)
  const departments = new Set<string>()
  for (const company of folders?.companies ?? []) {
    if (![company.id, company.slug].some((id) => id && scope.has(id))) {
      continue
    }
    for (const id of [company.id, company.slug]) {
      if (id) {
        scope.add(id)
      }
    }
    for (const department of company.domains) {
      for (const id of [department.id, department.name]) {
        if (id) {
          departments.add(id)
        }
      }
    }
  }
  // Why: handing work to yourself is a real path (a person step that returns it to you), so the reader stays listed.
  return roster.filter((person) => {
    if (me.company_scope === 'all') {
      return true
    }
    if (person.companies || person.department) {
      return Boolean(
        person.companies?.some((id) => scope.has(id)) ||
        (person.department && (departments.has(person.department) || scope.has(person.department)))
      )
    }
    // Why: with the folder map unread, nothing places a person with no company metadata inside
    // this member's companies; showing them would leak the rest of the estate.
    return folders !== null
  })
}

/** True when the list was narrowed on incomplete information and may be missing people. */
export function handoffPeopleMayBeIncomplete(input: {
  me: { company_scope: 'all' | readonly string[] }
  folders: WorkFolders | null
  serverScoped?: boolean
}): boolean {
  return !input.serverScoped && input.folders === null && input.me.company_scope !== 'all'
}
