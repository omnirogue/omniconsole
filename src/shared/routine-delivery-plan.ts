import type { Automation, AutomationRun } from './automations-types'
import { automationRunResult } from './automation-run-result'
import {
  DEFAULT_AUTOMATION_NOTIFY,
  type AutomationAlertChannel,
  type AutomationDelivery
} from './automation-definition-context'
import type { RoutineDeliveryPhase } from './routine-delivery-state'

export function routineDeliveryPlan(
  automation: Automation,
  run: AutomationRun,
  phase: RoutineDeliveryPhase
) {
  const definition = run.definitionSnapshot ?? automation
  const notify = definition.notify ?? DEFAULT_AUTOMATION_NOTIFY
  const notable = automationRunResult(run.outputSnapshot?.content ?? '').notable
  const outputs = (definition.delivery ?? [{ kind: 'chat' as const }]).filter(
    (target) => (target.kind === 'chat' || target.kind === 'file') === (phase === 'execution')
  )
  const alerts =
    phase === 'alerts' && notify.onFinish && (!notify.onlyWhenNotable || notable)
      ? notify.channels
      : []
  const entries = [
    ...outputs.map((output) => ({
      kind: output.kind,
      target: deliveryTarget(output, run),
      output
    })),
    ...alerts.map((alert) => ({ kind: alert.kind, target: alertTarget(alert), alert }))
  ]
  return [...new Map(entries.map((entry) => [`${entry.kind}:${entry.target}`, entry])).values()]
}
function deliveryTarget(target: AutomationDelivery, run: AutomationRun): string {
  switch (target.kind) {
    case 'chat':
      return run.id
    case 'file':
      return target.path
    case 'slack':
      return target.channel
    case 'google-drive':
      return target.folderId
    case 'hub-card':
      return target.scope
  }
}
function alertTarget(channel: AutomationAlertChannel): string {
  switch (channel.kind) {
    case 'slack-channel':
      return channel.channelId || channel.channelName
    case 'slack-dm':
      return channel.email || 'owner'
    case 'desktop':
    case 'email':
      return channel.kind
  }
}
