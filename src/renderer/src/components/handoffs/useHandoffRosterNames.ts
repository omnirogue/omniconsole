import { useCompaniesRead } from '@/components/companies/companies-client'
import { cachedHandoffRead } from '@/components/next-step/use-handoff-people'
import { handoffApi } from './handoff-client'

export function useHandoffRosterNames(scope: string) {
  const roster = useCompaniesRead(async () => {
    const response = await cachedHandoffRead(`roster:${scope}`, () => handoffApi().recipients())
    return response.ok
      ? { ...response, data: { scope, employees: response.data.employees } }
      : response
  }, scope)
  const employees = roster.data?.scope === scope ? roster.data.employees : []
  return (id: string, includeId = false): string => {
    const name = employees.find((person) => person.id === id)?.name.trim()
    return name ? (includeId ? `${name} (${id})` : name) : id
  }
}
