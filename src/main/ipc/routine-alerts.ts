import { ipcMain } from 'electron'
import { z } from 'zod'
import { join } from 'node:path'
import { hubSlackClient } from '../alerts/hub-slack-client'
import { desktopRoutineDeliveryAdapters } from '../alerts/routine-delivery-adapters'
import { remoteRoutineDeliveryAuthority } from '../alerts/remote-routine-delivery-authority'
import { routineSlackPayloadSchema } from '../../shared/routine-alert-contract'
import { getCanonicalUserDataPath } from '../persistence/loading-store/user-data-path'
import {
  RoutineRunDeliveryCoordinator,
  localRoutineDeliveryAuthority
} from '../automations/routine-run-delivery-coordinator'
import type { Store } from '../persistence'
import type { AutomationService } from '../automations/service'

const deliveryRequest = z.object({
  automationId: z.string().min(1),
  runId: z.string().min(1),
  environmentId: z.string().min(1).optional()
})
export function registerRoutineAlertHandlers(store: Store, automations?: AutomationService): void {
  const coordinators = new Map<string, RoutineRunDeliveryCoordinator>()
  const local = new RoutineRunDeliveryCoordinator(
    localRoutineDeliveryAuthority(store, () =>
      automations?.publishAutomationsChanged({ reason: 'run' })
    ),
    'alerts',
    join(store.getProfileStorageDirectory(), 'automation-output'),
    desktopRoutineDeliveryAdapters
  )
  ipcMain.handle('alerts:slack:status', () => hubSlackClient.status())
  ipcMain.handle('alerts:slack:listChannels', (_event, refresh: unknown) =>
    hubSlackClient.listChannels(refresh === true)
  )
  ipcMain.handle('alerts:slack:send', (_event, value: unknown) => {
    const payload = routineSlackPayloadSchema.safeParse(value)
    return payload.success
      ? hubSlackClient.send(payload.data)
      : { ok: false, error: 'Invalid Slack alert.' }
  })
  ipcMain.handle('alerts:deliverRun', async (_event, value: unknown) => {
    try {
      const { automationId, runId, environmentId } = deliveryRequest.parse(value)
      let coordinator = local
      if (environmentId) {
        const key = `${environmentId}:${runId}`
        coordinator =
          coordinators.get(key) ??
          new RoutineRunDeliveryCoordinator(
            remoteRoutineDeliveryAuthority(getCanonicalUserDataPath(), environmentId),
            'alerts',
            '',
            desktopRoutineDeliveryAdapters,
            `runtime:${environmentId}`
          )
        coordinators.set(key, coordinator)
        try {
          await coordinator.deliver(automationId, runId)
        } finally {
          coordinators.delete(key)
        }
      } else {
        await coordinator.deliver(automationId, runId)
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  if (automations) {
    automations.onCompletedRun = (run) => {
      void local
        .deliver(run.automationId, run.id)
        .catch((error) => console.warn('Routine alerts unavailable', error))
    }
    for (const run of store.listAutomationRuns()) {
      if (run.deliveryVersion === 1 && run.status === 'completed' && !run.deliveryClaims?.alerts) {
        automations.onCompletedRun(run)
      }
    }
  }
}
