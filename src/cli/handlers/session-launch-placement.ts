/**
 * `omni session launch --project`: rank every computer once (read-only), freeze the pick into the
 * launch record before any effect, create a fresh worktree there idempotently, then run the PR 1
 * launch on that route. A re-run follows the frozen record and never reads the fleet again.
 */

import type { LaunchPlacement } from '../../shared/agent-launch-placement-types'
import { toSshExecutionHostId } from '../../shared/execution-host'
import type { HandlerContext } from '../dispatch'
import { routedLaunchFlags } from '../launch-host-name'
import {
  defaultLaunchPlacementClients,
  launchPlacementRouteClient,
  type LaunchPlacementClients
} from '../launch-placement-clients'
import { noLaunchPlacementRefusal, withPlacementNextSteps } from '../launch-placement-refusals'
import { ensurePlacementWorktree } from '../launch-placement-worktree'
import { getDefaultUserDataPath, type RuntimeClient } from '../runtime-client'
import { withLaunchClaim } from '../session-launch-claim'
import {
  launchIntentInputs,
  launchIntentKey,
  newestLaunchRecord,
  readLaunchIntent,
  writeLaunchIntent
} from '../session-launch-intent'
import {
  agentLaunchRecordStore,
  mintLaunchOperationId,
  pruneLaunchRecords,
  type AgentLaunchRecord
} from '../session-launch-record'
import { incompatibleRuntimeRefusal } from '../session-launch-refusals'
import { completeLaunch } from './session-launch-complete'
import type { LaunchInput } from './session-launch-input'
import { planSessionLaunch } from './session-launch-plan'
import {
  assertLaunchPlacementChosen,
  freezeLaunchPlacement,
  placingLaunchRecord,
  rankLaunchPlacement,
  type PlacedLaunchRecord,
  type RankedLaunchPlacement
} from './session-launch-placement-plan'
import { assertRankedSetupOrder, printPlacementDryRun } from './session-launch-placement-preview'
import {
  beginLaunchSend,
  followLaunchRecord,
  launchRecordFromPlan,
  type LaunchContext,
  type PreparedLaunch
} from './session-launch-send'

type PlacementBase = Omit<LaunchContext, 'client'>
type PlacedRecord = PlacedLaunchRecord
type PlacedLaunch = { ctx: LaunchContext; prepared: PreparedLaunch; record: PlacedRecord }

function placementClient(
  placement: LaunchPlacement,
  clients: LaunchPlacementClients
): RuntimeClient {
  return launchPlacementRouteClient(placement.chosen.route, clients)
}

/** The PR 1 context for the placed route: --host and --worktree name it; the retry stays as typed. */
function placedLaunchContext(
  base: PlacementBase,
  placement: LaunchPlacement,
  worktree: string,
  client: RuntimeClient
): LaunchContext {
  const { route } = placement.chosen
  const host =
    route.kind === 'local'
      ? 'local'
      : route.kind === 'ssh'
        ? toSshExecutionHostId(route.targetId)
        : `runtime:${route.environmentId}`
  const flags = routedLaunchFlags(base.flags, {
    host,
    worktree,
    project: undefined,
    name: undefined
  })
  return { ...base, flags, client }
}

/** Worktree (once), then PR 1's plan on the placed route, then the full record and its send. */
async function continuePlacedLaunch(
  base: PlacementBase,
  placing: PlacedRecord,
  clients: LaunchPlacementClients
): Promise<PlacedLaunch> {
  let record = placing
  try {
    const client = placementClient(record.placement, clients)
    let worktree = record.placement.chosen.setup.selector
    if (record.placement.workspacePlan.kind === 'new-worktree') {
      const created = await ensurePlacementWorktree({
        store: base.store,
        record,
        client,
        now: clients.now
      })
      record = created.record
      worktree = `id:${created.worktreeId}`
    }
    const ctx = placedLaunchContext(base, record.placement, worktree, client)
    const plan = await planSessionLaunch(ctx, base.input, { preview: false })
    if (plan.legacy) {
      // Why: placement checked the capability; a runtime that lost it since gets no legacy send.
      throw incompatibleRuntimeRefusal({
        name: record.placement.chosen.label,
        local: plan.route.kind === 'local',
        appVersion: plan.status.appVersion
      })
    }
    const planned = launchRecordFromPlan(plan, {
      operationId: record.operationId,
      minted: true,
      intentKey: base.intentKey,
      now: record.createdAt,
      input: base.input
    })
    const { chosen, workspacePlan, createdWorktreeWarning } = record.placement
    const full = {
      ...planned,
      placement: record.placement,
      summary: {
        ...planned.summary,
        host: {
          ...planned.summary.host,
          why: `placed by rule v1: ${chosen.why}`,
          alsoReachableAs: []
        },
        warnings: [
          ...planned.summary.warnings,
          ...(createdWorktreeWarning ? [createdWorktreeWarning] : []),
          ...(workspacePlan.kind === 'folder'
            ? [
                `Launched into the shared folder ${workspacePlan.path}: other sessions there see and change the same files.`
              ]
            : [])
        ]
      }
    }
    base.store.write(full)
    return { ctx, prepared: beginLaunchSend(base.store, full), record: full }
  } catch (error) {
    throw withPlacementNextSteps(error, record)
  }
}

async function followPlacedLaunch(
  base: PlacementBase,
  found: AgentLaunchRecord,
  clients: LaunchPlacementClients
): Promise<PlacedLaunch> {
  const record = newestLaunchRecord(found, (operationId) => base.store.read(operationId))
  if (!record.placement) {
    throw noLaunchPlacementRefusal(record)
  }
  const placed = record as PlacedRecord
  if (placed.request === null) {
    return await continuePlacedLaunch(base, placed, clients)
  }
  const client = placementClient(placed.placement, clients)
  const ctx = placedLaunchContext(base, placed.placement, placed.request.worktree, client)
  if (placed.outcome === 'created') {
    return { ctx, prepared: { kind: 'already-launched', record: placed }, record: placed }
  }
  try {
    return { ctx, prepared: await followLaunchRecord(ctx, placed), record: placed }
  } catch (error) {
    throw withPlacementNextSteps(error, placed)
  }
}

/** Under the claim: follow this command's frozen placement, or freeze a new one and continue. */
async function preparePlacedLaunch(
  base: PlacementBase,
  rank: () => Promise<RankedLaunchPlacement>,
  clients: LaunchPlacementClients
): Promise<PlacedLaunch> {
  const intentOperationId = base.input.again ? null : readLaunchIntent(base.store, base.intentKey)
  const found = intentOperationId ? base.store.read(intentOperationId) : null
  if (found) {
    return await followPlacedLaunch(base, found, clients)
  }
  const ranked = await rank()
  await assertRankedSetupOrder(ranked, base.input, clients)
  const now = clients.now()
  const operationId = mintLaunchOperationId(now)
  const placing = placingLaunchRecord({
    input: base.input,
    intentKey: base.intentKey,
    placement: freezeLaunchPlacement(ranked, base.input, operationId),
    operationId,
    now
  })
  base.store.write(placing)
  writeLaunchIntent(base.store, base.intentKey, operationId, now)
  try {
    pruneLaunchRecords(base.store, now)
  } catch {
    // Pruning is housekeeping; a failure must not block a recorded launch.
  }
  return await continuePlacedLaunch(base, placing, clients)
}

export async function runPlacedLaunch(
  ctx: Pick<HandlerContext, 'flags' | 'cwd' | 'json'>,
  input: LaunchInput,
  clients: LaunchPlacementClients = defaultLaunchPlacementClients()
): Promise<void> {
  if (input.dryRun) {
    // Why: a preview follows a frozen pick or ranks afresh, and records or creates nothing.
    await printPlacementDryRun(ctx, input, clients)
    return
  }
  const store = agentLaunchRecordStore(getDefaultUserDataPath())
  const intentKey = launchIntentKey(launchIntentInputs(ctx.flags, ctx.cwd, input.prompt))
  const base: PlacementBase = { flags: ctx.flags, cwd: ctx.cwd, input, store, intentKey }
  // Why: the fleet read is long and read-only, so it runs before the claim; a re-run whose intent
  // already names an operation follows that record instead and never reads the fleet again.
  const intentOperationId = input.again ? null : readLaunchIntent(store, intentKey)
  const ranked =
    intentOperationId && store.read(intentOperationId)
      ? null
      : await rankLaunchPlacement({ flags: ctx.flags, input, clients })
  if (ranked) {
    assertLaunchPlacementChosen(ranked, input)
  }
  const rank = async (): Promise<RankedLaunchPlacement> =>
    ranked ?? (await rankLaunchPlacement({ flags: ctx.flags, input, clients }))
  const placed = await withLaunchClaim(store, intentKey, () =>
    preparePlacedLaunch(base, rank, clients)
  )
  await completeLaunch(placed.ctx, placed.prepared, {
    json: ctx.json,
    onSendError: (error) => withPlacementNextSteps(error, placed.record)
  })
}
