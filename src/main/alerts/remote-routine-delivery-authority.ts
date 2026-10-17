import { resolveEnvironment } from '../../shared/runtime-environment-store'
import { callRuntimeEnvironment } from '../ipc/runtime-environment-transport-routing'
import type { Automation, AutomationRun } from '../../shared/automations-types'
import type { AutomationOwnerPrecondition } from '../../shared/automation-owner-precondition'
import type { RoutineDeliveryAuthority } from '../automations/routine-run-delivery-coordinator'

export function remoteRoutineDeliveryAuthority(
  userDataPath: string,
  environmentId: string
): RoutineDeliveryAuthority {
  const environment = resolveEnvironment(userDataPath, environmentId)
  const revision = environment.pairingRevision ?? environment.createdAt
  const owners = new Map<string, AutomationOwnerPrecondition | undefined>()
  const call = async <T>(method: string, params: unknown): Promise<T> => {
    const response = await callRuntimeEnvironment(
      userDataPath,
      environmentId,
      method,
      params,
      15_000,
      revision
    )
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    return response.result as T
  }
  return {
    read: async (automationId, runId) => {
      const { automation, owner } = await call<{
        automation: Automation
        owner?: AutomationOwnerPrecondition
      }>('automation.show', { id: automationId })
      owners.set(automationId, owner)
      const { runs } = await call<{ runs: AutomationRun[] }>('automation.runs', {
        automationId,
        expectedOwner: owner
      })
      const run = runs.find((entry) => entry.id === runId)
      if (!run) {
        throw new Error('Routine run not found on the execution host.')
      }
      return { automation, run }
    },
    write: (input) =>
      call('automation.delivery', { ...input, expectedOwner: owners.get(input.automationId) })
  }
}
