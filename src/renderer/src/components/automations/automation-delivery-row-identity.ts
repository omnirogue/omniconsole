import type { AutomationDelivery } from '../../../../shared/automation-definition-context'

const ids = new WeakMap<AutomationDelivery, string>()
export const DEFAULT_DELIVERY: AutomationDelivery[] = [{ kind: 'chat' }]

export function deliveryRowIdentity(target: AutomationDelivery): string {
  let id = ids.get(target)
  if (!id) {
    id = crypto.randomUUID()
    ids.set(target, id)
  }
  return id
}

export function replaceDeliveryRow(
  previous: AutomationDelivery,
  next: AutomationDelivery
): AutomationDelivery {
  ids.set(next, deliveryRowIdentity(previous))
  return next
}
