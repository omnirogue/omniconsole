import { evolveChangedEvent } from '../../../shared/evolve-workflow-status'
import type { EvolveRunRecord } from '../../../shared/evolve-workflow'
import type { OrcaRuntimeService } from '../omni-runtime'
import { attachEvolveDecision, scheduleEvolveToOmnios } from './evolve-omnios-delivery'
import { defaultEvolveRunDirectory, EvolveRunStore } from './evolve-run-store'
import { EvolveService } from './evolve-service'

const servicesByRuntime = new WeakMap<OrcaRuntimeService, EvolveService>()

function enrichWithDecision(runtime: OrcaRuntimeService, record: EvolveRunRecord): EvolveRunRecord {
  try {
    const db =
      typeof runtime.getOrchestrationDb === 'function'
        ? runtime.getOrchestrationDb()?.db
        : undefined
    return db ? attachEvolveDecision(db, record) : record
  } catch {
    return record
  }
}

/** One Evolve service per runtime, its runs kept on disk; the tab showing a run gets its changes. */
export function getEvolveService(runtime: OrcaRuntimeService): EvolveService {
  const existing = servicesByRuntime.get(runtime)
  if (existing) {
    return existing
  }
  const store = new EvolveRunStore(defaultEvolveRunDirectory())
  const notify = (record: EvolveRunRecord) => {
    const event = evolveChangedEvent(record)
    if (event) {
      runtime.notifyLocalWorkflowChanged(event)
    }
  }
  const service = new EvolveService({
    store,
    notify,
    onSettled: (record) => {
      if (record.state !== 'done') {
        return
      }
      const db =
        typeof runtime.getOrchestrationDb === 'function'
          ? runtime.getOrchestrationDb()?.db
          : undefined
      if (!db) {
        return
      }
      void scheduleEvolveToOmnios(
        {
          db,
          store,
          notify,
          log: (line) => console.info(`[evolve] ${line}`),
          publish: (request) => runtime.publishArtifact(request)
        },
        record
      ).catch((error) => console.warn('[evolve] Decision delivery failed:', error))
    }
  })
  const rawShow = service.show.bind(service)
  const rawList = service.list.bind(service)
  const rawRefresh = service.refresh.bind(service)
  service.show = (id: string) => enrichWithDecision(runtime, rawShow(id))
  service.list = () => rawList().map((record) => enrichWithDecision(runtime, record))
  service.refresh = async (id: string) => enrichWithDecision(runtime, await rawRefresh(id))
  servicesByRuntime.set(runtime, service)
  return service
}
