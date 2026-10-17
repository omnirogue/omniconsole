import { getAgentCatalog } from './agent-catalog'
import { translate } from '@/i18n/i18n'
import type { NextStepAvailableAgent } from '@/components/next-step/use-next-step-recipients'
import type { CatalogModel } from '../../../shared/agent-session-option-catalog'
import type { ConsoleConversationFleetInventory } from '../../../shared/console-conversation-fleet-types'
import { conversationFleetCapabilityModels } from '../../../shared/conversation-fleet-capability-usage'

/** Membership comes from the chosen fleet host, never this desktop's CLI or account. */
export function conversationFleetAgents(
  inventory: ConsoleConversationFleetInventory,
  machine?: string,
  now = Date.now()
): NextStepAvailableAgent[] {
  if (inventory.models_fallback) {
    return []
  }
  const hosts = inventory.machines.filter(
    (host) => host.allowed && (machine ? host.host === machine : host.ready)
  )
  return getAgentCatalog().flatMap((agent) => {
    const offered = inventory.models
      .filter((model) => model.provider === agent.id)
      .flatMap((model) => {
        // OMP inventory carries authenticated host catalog + tools metadata, not subscription usage.
        if (agent.id === 'omp') {
          return machine &&
            model.seat_ready === true &&
            model.hosts?.includes(machine) &&
            hosts.some((host) => host.host === machine && host.ready)
            ? [{ model, efforts: [] }]
            : []
        }
        const capabilities = hosts
          .flatMap((host) => host.execution_capabilities)
          .filter(
            (capability) =>
              capability.provider === agent.id &&
              conversationFleetCapabilityModels(
                capability,
                [{ id: model.model, label: model.model, options: [] }],
                now
              ).length > 0
          )
        return capabilities.length
          ? [
              {
                model,
                efforts: model.supported_efforts.filter((effort) =>
                  capabilities.some((capability) => capability.efforts.includes(effort))
                )
              }
            ]
          : []
      })
    const models: CatalogModel[] = offered.map(({ model, efforts }) => ({
      id: model.model,
      label: model.model,
      isDefault: model.default,
      ...(model.hosts ? { hosts: [...model.hosts] } : {}),
      options: efforts.length
        ? [
            {
              id: 'effort',
              label: translate('conversationFleet.effort', 'Effort'),
              kind: {
                type: 'select',
                choices: efforts.map((effort) => ({ value: effort, label: effort })),
                defaultValue: efforts[0]
              },
              apply: {}
            }
          ]
        : []
    }))
    return models.length ? [{ ...agent, status: 'usable', models, checkedAt: now }] : []
  })
}
