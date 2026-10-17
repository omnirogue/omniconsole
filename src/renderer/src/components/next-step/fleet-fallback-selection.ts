import { translate } from '@/i18n/i18n'
import type { CatalogModel } from '../../../../shared/agent-session-option-catalog'
import type { NextStepActor } from '../../../../shared/next-step-draft'
import { openrouterApiId, validOpenRouterRoute } from '../../../../shared/openrouter-route'

/** Backend inventory owns route policy; only its exact selected-host rows become choices. */
export function fleetFallbackChoices(models: readonly CatalogModel[], machine?: string) {
  if (!machine) {
    return []
  }
  return models.flatMap((model) => {
    if (!model.hosts?.includes(machine) || !model.id.startsWith('openrouter/')) {
      return []
    }
    const id = model.id.slice('openrouter/'.length)
    return openrouterApiId.safeParse(id).success ? [{ id, label: model.label }] : []
  })
}

export function fleetFallbackProblem(
  actor: NextStepActor,
  models: readonly CatalogModel[] | undefined,
  machine?: string
): string | null {
  if (models === undefined) {
    return actor.openrouterCandidates === undefined
      ? null
      : translate(
          'nextStep.fleetFallback.fleetOnly',
          'This saved fallback list requires fleet dispatch. Open Dispatch, or clear the list to use one fixed model here.'
        )
  }
  if (actor.agent !== 'omp' && actor.openrouterCandidates === undefined) {
    return null
  }
  if (!validOpenRouterRoute(actor)) {
    return translate(
      'nextStep.fleetFallback.invalidOrder',
      'Fallbacks require OMP and the selected model first, with no duplicates. Review the saved order or clear the list.'
    )
  }
  if (!machine) {
    return translate(
      'nextStep.fleetFallback.chooseHost',
      'Choose an explicit fleet host to verify these OpenRouter models. Automatic host selection cannot verify a fallback list.'
    )
  }
  const choices = fleetFallbackChoices(models, machine)
  const selected = actor.model?.startsWith('openrouter/')
    ? actor.model.slice('openrouter/'.length)
    : null
  if (!selected || !choices.some((choice) => choice.id === selected)) {
    return translate(
      'nextStep.fleetFallback.primaryUnavailable',
      'Choose a model advertised by the selected fleet host. The saved model is unavailable; refresh host inventory or choose another host.'
    )
  }
  const missing = actor.openrouterCandidates?.filter(
    (candidate) => !choices.some((choice) => choice.id === candidate)
  )
  return missing?.length
    ? translate(
        'nextStep.fleetFallback.candidatesUnavailable',
        'These saved models are unavailable on this host: {{models}}. Refresh inventory, choose the original host, or remove them explicitly.',
        { models: missing.join(', ') }
      )
    : null
}
