import { automationRunDefinition } from '../../shared/automation-run-definition'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Store } from '../persistence'
import type { Automation, AutomationRun } from '../../shared/automations-types'
import type {
  RoutineDeliveryPhase,
  RoutineDeliveryWrite
} from '../../shared/routine-delivery-state'
import { deliverRoutineRun, type RoutineDeliveryAdapters } from './routine-run-delivery'
import { buildRoutineRunLink } from '../../shared/routine-run-link'

export type RoutineDeliveryAuthority = {
  read: (
    automationId: string,
    runId: string
  ) => Promise<{ automation: Automation; run: AutomationRun }>
  write: (input: RoutineDeliveryWrite) => ReturnType<Store['writeAutomationDelivery']>
}
export class RoutineRunDeliveryCoordinator {
  private readonly pending = new Map<string, Promise<void>>()
  constructor(
    private readonly authority: RoutineDeliveryAuthority,
    private readonly phase: RoutineDeliveryPhase,
    private readonly artifactDirectory: string,
    private readonly adapters?: RoutineDeliveryAdapters,
    private readonly hostId = 'local'
  ) {}

  deliver(automationId: string, runId: string): Promise<void> {
    const existing = this.pending.get(runId)
    if (existing) {
      return existing
    }
    const task = this.attempt(automationId, runId).finally(() => this.pending.delete(runId))
    this.pending.set(runId, task)
    return task
  }
  private async attempt(automationId: string, runId: string): Promise<void> {
    const observed = await this.authority.read(automationId, runId)
    const run = observed.run
    const automation = automationRunDefinition(observed.automation, run)
    if (
      run.deliveryVersion !== 1 ||
      run.status !== 'completed' ||
      run.deliveryClaims?.[this.phase]
    ) {
      return
    }
    const adapters = (await this.adapters?.prepare?.()) ?? this.adapters
    const claim = { automationId, runId, phase: this.phase, claimId: randomUUID() }
    const { acquired } = await this.authority.write(claim)
    if (!acquired) {
      return
    }
    const results = await deliverRoutineRun(automation, run, join(this.artifactDirectory, runId), {
      phase: this.phase,
      adapters,
      link: buildRoutineRunLink({
        automationId,
        runId,
        hostId: this.hostId === 'local' ? (run.deliveryHostId ?? 'local') : this.hostId
      })
    })
    await this.authority.write({ ...claim, results })
  }
}
export function localRoutineDeliveryAuthority(
  store: Store,
  publish: () => void = () => {}
): RoutineDeliveryAuthority {
  return {
    read: async (automationId, runId) => {
      const automation = store.listAutomations().find((entry) => entry.id === automationId)
      const run = store.listAutomationRuns(automationId).find((entry) => entry.id === runId)
      if (!automation || !run) {
        throw new Error('Routine run not found.')
      }
      return { automation, run }
    },
    write: async (input) => {
      const result = await store.writeAutomationDelivery(input)
      publish()
      return result
    }
  }
}

export function createRoutineExecutionDelivery(
  store: Store,
  publish: () => void
): (run: AutomationRun) => void {
  const coordinator = new RoutineRunDeliveryCoordinator(
    localRoutineDeliveryAuthority(store, publish),
    'execution',
    join(store.getProfileStorageDirectory(), 'automation-output')
  )
  return (run) => {
    void coordinator
      .deliver(run.automationId, run.id)
      .catch((error) => console.warn('Routine file delivery failed', error))
  }
}
