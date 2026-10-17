import { companiesApi, useCompaniesRead } from '@/components/companies/companies-client'
import { isActiveCompanyGoal } from '@/components/next-step/next-step-card-filing'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'

export function TaskGoalField({
  companyId,
  unitId,
  goalId,
  disabled,
  onChange
}: {
  companyId: string
  unitId: string
  goalId: string
  disabled?: boolean
  onChange: (goalId: string) => void
}) {
  const company = useCompaniesRead(
    () => companiesApi().company({ companyId }),
    `task-goals:${companyId}`,
    Boolean(companyId && unitId)
  )
  const goals =
    company.data?.company_id === companyId
      ? (company.data.goals.items ?? []).filter(
          (goal) => goal.org_unit_id === unitId && isActiveCompanyGoal(goal)
        )
      : []
  const unavailable = Boolean(company.error) || company.data?.goals.available === false
  return (
    <div className="space-y-1">
      <Label htmlFor="create-task-goal" className="text-xs">
        {translate('tasks.goal', 'Goal')}
      </Label>
      <Select
        value={goalId || 'none'}
        onValueChange={(value) => onChange(value === 'none' ? '' : value)}
        disabled={disabled || !companyId || !unitId || company.loading || unavailable}
      >
        <SelectTrigger
          id="create-task-goal"
          size="sm"
          className="w-full text-xs"
          aria-label={translate('tasks.goal', 'Goal')}
        >
          <SelectValue placeholder={translate('tasks.noGoal', 'None')} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">{translate('tasks.noGoal', 'None')}</SelectItem>
          {goals.map((goal) => (
            <SelectItem key={goal.id} value={goal.id!}>
              {goal.title ?? goal.id}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-[11px] text-muted-foreground">
        {translate(
          'tasks.goalDispatchHint',
          'Choose an active goal to dispatch this task to an agent.'
        )}
      </p>
      {companyId &&
        unitId &&
        !company.loading &&
        (unavailable ? (
          <div className="flex items-center gap-2 text-xs" role="alert">
            <span>{translate('tasks.goalsUnavailable', 'Goals could not be read.')}</span>
            <Button variant="ghost" size="xs" disabled={disabled} onClick={company.reload}>
              {translate('tasks.reloadGoals', 'Reload goals')}
            </Button>
          </div>
        ) : goals.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {translate(
              'tasks.noActiveGoals',
              'This department has no active goal. The task can be saved, but dispatch needs an active goal.'
            )}
          </p>
        ) : null)}
    </div>
  )
}
