import { useNextStepPeople } from '@/components/next-step/use-next-step-recipients'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { selectConsoleAccountScope } from '@/lib/console-account-scope'
import { useAppStore } from '@/store'
import type { useTaskDraft } from './use-task-draft'
import { TaskGoalField } from './TaskGoalField'

const NONE = 'none'
export function TaskFilingFields({
  draft,
  set,
  companies,
  departments,
  projects,
  disabled
}: Pick<
  ReturnType<typeof useTaskDraft>,
  'draft' | 'set' | 'companies' | 'departments' | 'projects'
> & { disabled?: boolean }) {
  const recipients = useNextStepPeople()
  const scope = useAppStore(selectConsoleAccountScope)
  const people = recipients.people.phase === 'ready' ? recipients.people.value : []
  const otherCompanies = companies.filter((company) => company.id && company.id !== draft.companyId)
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs" data-create-task-proposed>
        <Checkbox
          id="create-task-proposed"
          checked={draft.proposed}
          disabled={disabled}
          onCheckedChange={(checked) => set({ proposed: checked === true })}
        />
        <Label htmlFor="create-task-proposed" className="text-xs">
          {translate('tasks.proposedIdea', 'Proposed idea')}
        </Label>
        <span className="text-muted-foreground">
          {translate(
            'tasks.proposedIdeaHint',
            'Lands on the Kanban’s Proposed lane; nobody starts it until it is moved.'
          )}
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Picker
          id="create-task-company"
          label={translate('tasks.company', 'Company')}
          value={draft.companyId}
          placeholder={translate('tasks.noCompany', 'Unfiled')}
          options={companies.map((company) => ({
            value: company.id ?? '',
            label: company.name ?? company.slug ?? ''
          }))}
          disabled={disabled}
          onChange={(companyId) => set({ companyId })}
        />
        <Picker
          id="create-task-department"
          label={translate('tasks.department', 'Department')}
          value={draft.unitId}
          placeholder={translate('tasks.noDepartment', 'None')}
          disabled={disabled || !draft.companyId}
          options={departments.map((department) => ({
            value: department.id ?? '',
            label: department.name ?? ''
          }))}
          onChange={(unitId) => set({ unitId })}
        />
      </div>
      {otherCompanies.length > 0 && (
        <div className="space-y-1">
          <Label className="text-xs">{translate('tasks.alsoForCompanies', 'Also for')}</Label>
          <div className="flex flex-wrap gap-1.5" data-create-task-companies>
            {otherCompanies.map((company) => {
              const id = company.id ?? ''
              const chosen = draft.additionalCompanyIds.includes(id)
              return (
                <button
                  key={id}
                  type="button"
                  disabled={disabled}
                  aria-pressed={chosen}
                  onClick={() =>
                    set({
                      additionalCompanyIds: chosen
                        ? draft.additionalCompanyIds.filter((value) => value !== id)
                        : [...draft.additionalCompanyIds, id]
                    })
                  }
                  className={cn(
                    'rounded-full border px-2 py-0.5 text-xs',
                    chosen
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-border text-muted-foreground hover:text-foreground'
                  )}
                >
                  {company.name ?? company.slug ?? id}
                </button>
              )
            })}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {translate(
              'tasks.alsoForCompaniesHint',
              'One card, several companies. The department and project stay with the first company.'
            )}
          </p>
        </div>
      )}
      <TaskGoalField
        key={`${scope}:${draft.companyId}:${draft.unitId}`}
        companyId={draft.companyId}
        unitId={draft.unitId}
        goalId={draft.goalId}
        disabled={disabled}
        onChange={(goalId) => set({ goalId })}
      />
      <Picker
        id="create-task-project"
        label={translate('tasks.project', 'Project (optional)')}
        value={draft.projectId}
        placeholder={translate('tasks.noProject', 'None')}
        disabled={disabled || !draft.unitId || projects.length === 0}
        options={projects.map((project) => ({
          value: project.id ?? '',
          label: project.name ?? ''
        }))}
        onChange={(projectId) => set({ projectId })}
      />
      <div className="space-y-1">
        <Label className="text-xs">{translate('tasks.people', 'People')}</Label>
        <div className="flex flex-wrap gap-1.5" data-create-task-people>
          {people.length === 0 ? (
            <span className="text-xs text-muted-foreground">
              {translate('tasks.peopleUnavailable', 'The roster is not available.')}
            </span>
          ) : (
            people.map((person) => {
              const chosen = draft.people.includes(person.id)
              return (
                <button
                  key={person.id}
                  type="button"
                  disabled={disabled}
                  aria-pressed={chosen}
                  onClick={() =>
                    set({
                      people: chosen
                        ? draft.people.filter((id) => id !== person.id)
                        : [...draft.people, person.id]
                    })
                  }
                  className={cn(
                    'rounded-full border px-2 py-0.5 text-xs',
                    chosen
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-border text-muted-foreground hover:text-foreground'
                  )}
                >
                  {person.name}
                </button>
              )
            })
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">
          {translate(
            'tasks.peopleHint',
            'Everyone involved. Who acts next is decided by ＋ Add Next, not here.'
          )}
        </p>
      </div>
    </div>
  )
}
function Picker({
  id,
  label,
  value,
  placeholder,
  options,
  disabled = false,
  onChange
}: {
  id: string
  label: string
  value: string
  placeholder: string
  options: readonly { value: string; label: string }[]
  disabled?: boolean
  onChange: (value: string) => void
}): React.JSX.Element {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Select
        value={value || NONE}
        onValueChange={(next) => onChange(next === NONE ? '' : next)}
        disabled={disabled}
      >
        <SelectTrigger id={id} size="sm" className="w-full text-xs" aria-label={label}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{placeholder}</SelectItem>
          {options
            .filter((option) => option.value)
            .map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
    </div>
  )
}
