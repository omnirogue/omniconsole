import type Database from '../../sqlite/sync-database'
import type { LocalWorkflowView } from '../../../shared/local-workflow-view'
import {
  scheduleEvolveToOmnios,
  type EvolveDecisionPublisher
} from '../evolve/evolve-omnios-delivery'
import { defaultEvolveRunDirectory, EvolveRunStore } from '../evolve/evolve-run-store'
import {
  discoverOmniosEnabled,
  scheduleDiscoverToOmnios,
  type DiscoverOmniosDelivery
} from './discover-omnios-delivery'
import { discoverOutbox } from './discover-omnios-outbox'

function resolveEvolveStore(explicit?: EvolveRunStore): EvolveRunStore | null {
  if (explicit) {
    return explicit
  }
  try {
    return new EvolveRunStore(defaultEvolveRunDirectory())
  } catch {
    return null
  }
}

/** Startup and periodic recovery use journal projections, never resume paid workflow calls. */
export async function reconcileDiscoverDeliveries(
  deps: Omit<DiscoverOmniosDelivery, 'view'> & {
    db: Database.Database
    view: (id: string) => Promise<LocalWorkflowView>
    evolveStore?: EvolveRunStore
    now?: () => number
    publishEvolveDecision?: EvolveDecisionPublisher
  }
): Promise<void> {
  if (!discoverOmniosEnabled(deps.env)) {
    return
  }
  const outbox = discoverOutbox(deps.db)
  const rows = deps.db
    .prepare("SELECT id FROM local_workflow_executions WHERE state='completed'")
    .all() as { id: string }[]
  for (const { id } of rows) {
    if (!outbox.due(id)) {
      continue
    }
    try {
      await scheduleDiscoverToOmnios({ ...deps, view: () => deps.view(id) }, id, [])
    } catch (error) {
      deps.log?.(`Discover ${id}: delivery reconciliation failed: ${String(error)}`)
    }
  }
  const evolveStore = resolveEvolveStore(deps.evolveStore)
  if (!evolveStore) {
    return
  }
  for (const record of evolveStore.load()) {
    if (record.state !== 'done' || !outbox.due(record.id)) {
      continue
    }
    try {
      await scheduleEvolveToOmnios(
        {
          db: deps.db,
          store: evolveStore,
          root: deps.root,
          env: deps.env,
          now: deps.now,
          log: deps.log,
          publish: deps.publishEvolveDecision
        },
        record
      )
    } catch (error) {
      deps.log?.(`Evolve ${record.id}: decision reconciliation failed: ${String(error)}`)
    }
  }
}
