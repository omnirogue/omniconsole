import { translate } from '@/i18n/i18n'
import type { CatalogModel } from '../../../../shared/agent-session-option-catalog'
import {
  nextStepOutcomeProblems,
  type NextStepActor,
  type NextStepOutcomeDraft
} from '../../../../shared/next-step-draft'
import { openrouterApiId, validOpenRouterRoute } from '../../../../shared/openrouter-route'
import type { NextStepAvailableAgent } from './use-next-step-recipients'

/** Only the execution host may attach this routing evidence to a discovered model. */
export function localFallbackModels(models: readonly CatalogModel[]): CatalogModel[] {
  return models.filter((model) => model.openrouterRouting === 'omp-openrouter-routing-v1')
}

export function localFallbackChoices(models: readonly CatalogModel[]) {
  return localFallbackModels(models).flatMap((model) => {
    if (!model.id.startsWith('openrouter/')) {
      return []
    }
    const id = model.id.slice('openrouter/'.length)
    return openrouterApiId.safeParse(id).success ? [{ id, label: model.label }] : []
  })
}

export function localFallbackProblem(
  actor: NextStepActor,
  models: readonly CatalogModel[]
): string | null {
  if (actor.agent !== 'omp' && actor.openrouterCandidates === undefined) {
    return null
  }
  if (!validOpenRouterRoute(actor)) {
    return translate(
      'nextStep.fleetFallback.invalidOrder',
      'Fallbacks require OMP and the selected model first, with no duplicates. Review the saved order or clear the list.'
    )
  }
  const choices = localFallbackChoices(models)
  if (!actor.model || !choices.some((choice) => `openrouter/${choice.id}` === actor.model)) {
    return translate(
      'nextStep.localFallback.unavailable',
      'This execution host has not verified the selected OpenRouter model and routing support. Refresh model discovery or choose a supported host and model; the saved route is retained.'
    )
  }
  const missing = actor.openrouterCandidates?.filter(
    (candidate) => !choices.some((choice) => choice.id === candidate)
  )
  return missing?.length
    ? translate(
        'nextStep.localFallback.missing',
        'These saved fallback models are not verified on this execution host: {{models}}. Refresh discovery or remove them explicitly.',
        { models: missing.join(', ') }
      )
    : null
}

export function reviewerFallbackProblem(actor: NextStepActor): string | null {
  return actor.openrouterCandidates === undefined
    ? null
    : translate(
        'nextStep.localFallback.reviewerUnsupported',
        'Fallback lists are not supported for reviewer seats. Clear the saved list to retain a fixed reviewer model.'
      )
}

export async function refreshLocalOutcomeProblems(
  outcomes: NextStepOutcomeDraft[] | undefined,
  refreshAgents: () => Promise<NextStepAvailableAgent[]>
): Promise<string[]> {
  const problems = nextStepOutcomeProblems(outcomes)
  const actors = (outcomes ?? []).flatMap((outcome) =>
    outcome.steps.flatMap((step) => {
      if (step.kind === 'review') {
        for (const reviewer of step.reviewers) {
          const problem = reviewerFallbackProblem(reviewer)
          if (problem) {
            problems.push(problem)
          }
        }
        return []
      }
      return step.actor &&
        (step.actor.agent === 'omp' || step.actor.openrouterCandidates !== undefined)
        ? [step.actor]
        : []
    })
  )
  if (problems.length || !actors.length) {
    return problems
  }
  try {
    const fresh = await refreshAgents()
    for (const actor of actors) {
      const models =
        fresh.find((entry) => entry.id === actor.agent && entry.status === 'usable')?.models ?? []
      const problem = localFallbackProblem(actor, models)
      if (problem) {
        problems.push(problem)
      }
    }
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error))
  }
  return problems
}
