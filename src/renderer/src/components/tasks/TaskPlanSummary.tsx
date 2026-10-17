import { translate } from '@/i18n/i18n'
import { taskPlanFromSteps, type TaskPlan } from '../../../../shared/task-details'

export function TaskPlanSummary({
  plan,
  sequentialSteps,
  names
}: {
  plan?: TaskPlan | null
  sequentialSteps?: readonly string[] | null
  names: ReadonlyMap<string, string>
}): React.JSX.Element | null {
  const steps = plan?.steps ?? taskPlanFromSteps(sequentialSteps ?? []).steps
  if (!plan && steps.length === 0) {
    return null
  }
  return (
    <section className="space-y-2">
      {plan && (
        <p className="text-xs">
          <span className="font-medium">{translate('tasks.completionLabel', 'Finish with:')}</span>{' '}
          {plan.completion_mode === 'deployment'
            ? translate('tasks.deploymentOutcome', 'Deployment')
            : translate('tasks.deliverableOutcome', 'Finished deliverable')}
          {plan.completion_mode === 'deployment' && plan.deployment_target
            ? ` · ${plan.deployment_target}`
            : ''}
        </p>
      )}
      {steps.length > 0 && (
        <>
          <h4 className="text-xs font-medium">{translate('tasks.savedSteps', 'Steps')}</h4>
          <ol className="list-decimal space-y-2 pl-4 text-sm">
            {steps.map((step) => (
              <li key={step.id} className="whitespace-pre-wrap break-words">
                {step.title}
                {step.actor_ids.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {translate('tasks.actorLabel', 'Actor:')}{' '}
                    {step.actor_ids.map((actor) => names.get(actor) ?? actor).join(', ')}
                  </p>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  )
}
