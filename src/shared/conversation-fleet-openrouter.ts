import type { ConsoleConversationFleetInventory } from './console-conversation-fleet-types'
import type { ConsoleWorkflowStep } from './console-workflow-types'
import { assertOpenRouterRoute, openrouterApiId } from './openrouter-route'

/** Only the execution host's advertised catalog grants fleet routing capability. */
export function assertConversationFleetOpenRouterRoutes(
  steps: ConsoleWorkflowStep[],
  inventory: ConsoleConversationFleetInventory
): void {
  for (const step of steps) {
    const actor = step.actor_id ?? step.actor ?? ''
    const separator = actor.indexOf(':')
    const agent = separator === -1 ? actor : actor.slice(0, separator)
    const model = separator === -1 ? undefined : actor.slice(separator + 1)
    assertOpenRouterRoute({
      agent,
      model,
      openrouterCandidates: step.openrouter_candidates
    })
    if (agent !== 'omp') {
      continue
    }
    if (!model?.startsWith('openrouter/') || !openrouterApiId.safeParse(model.slice(11)).success) {
      throw new Error('Fleet OMP requires an exact OpenRouter model selector.')
    }
    const host = inventory.machines.find((machine) => machine.host === step.machine)
    if (inventory.models_fallback || !host?.allowed || !host.ready) {
      throw new Error('Choose an explicitly advertised ready OMP execution host.')
    }
    const candidates = step.openrouter_candidates ?? [model.slice(11)]
    for (const candidate of candidates) {
      const full = `openrouter/${candidate}`
      if (
        !inventory.models.some(
          (row) =>
            row.provider === 'omp' &&
            row.id === `omp:${full}` &&
            row.model === full &&
            row.seat_ready === true &&
            row.hosts?.includes(host.host) &&
            (!step.effort || row.supported_efforts.includes(step.effort))
        )
      ) {
        throw new Error(
          'The execution host does not advertise every selected OpenRouter candidate.'
        )
      }
    }
  }
}
