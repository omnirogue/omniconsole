import type { CatalogModel } from './agent-session-option-catalog'
import type { ConsoleConversationFleetMachine } from './console-conversation-fleet-types'
import { fleetAccountUsageReceiptSchema } from './fleet-account-usage'
import { assessWorkAgentAvailability } from './work-agent-availability'

type Capability = ConsoleConversationFleetMachine['execution_capabilities'][number]

/** A route and its usage receipt must describe the same execution account. */
export function conversationFleetCapabilityModels(
  capability: Capability,
  models: CatalogModel[],
  now: number
): CatalogModel[] {
  const parsed = fleetAccountUsageReceiptSchema.safeParse(capability.account_usage)
  const usage = parsed.success ? parsed.data.usage : null
  if (
    !usage ||
    usage.provider !== capability.provider ||
    usage.updatedAt <= 0 ||
    usage.updatedAt > now
  ) {
    return []
  }
  return assessWorkAgentAvailability({
    installed:
      capability.available &&
      capability.resume &&
      capability.readonly &&
      capability.native_execution === true &&
      capability.pinned_task_inputs === true &&
      capability.source_snapshot === true,
    disabled: false,
    models: models.filter((model) => capability.models.includes(model.id)),
    usage,
    now
  }).models
}
