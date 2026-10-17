import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useHandoffPeople } from '@/components/next-step/use-handoff-people'

/** Use the same authorized employee directory as Send, including people with no agent sessions. */
export function EmployeePeopleList() {
  const { people, reload } = useHandoffPeople()
  return (
    <section
      className="space-y-2 border-b p-3"
      aria-label={translate('employeePeople.people', 'People')}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{translate('employeePeople.people', 'People')}</h3>
        <Button size="xs" variant="ghost" onClick={reload}>
          {translate('employeePeople.refresh', 'Refresh people')}
        </Button>
      </div>
      {people.phase === 'loading' ? (
        <p role="status" className="text-xs text-muted-foreground">
          {translate('employeePeople.loading', 'Loading employees…')}
        </p>
      ) : people.phase === 'error' ? (
        <p role="alert" className="text-xs">
          {people.message}
        </p>
      ) : (
        <ul className="space-y-2">
          {people.value.map((person) => (
            <li key={person.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="truncate">{person.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {translate('employeePeople.presenceUnknown', 'Presence unavailable')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
