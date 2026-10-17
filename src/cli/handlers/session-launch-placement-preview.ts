/**
 * `omni session launch --project --dry-run`, and the setup-order check both it and the real launch
 * run on the pick before it is frozen. A preview records, creates and launches nothing.
 */

import { launchCandidateSummary } from '../../shared/agent-launch-placement'
import type { LaunchPlacement } from '../../shared/agent-launch-placement-types'
import type { HandlerContext } from '../dispatch'
import { printResult } from '../format'
import {
  launchPlacementRouteClient,
  type LaunchPlacementClients
} from '../launch-placement-clients'
import {
  formatLaunchPlacementPreview,
  type LaunchPlacementPreview
} from '../launch-placement-format'
import { noLaunchPlacementRefusal } from '../launch-placement-refusals'
import { assertPlacementSetupOrder } from '../launch-placement-setup-order'
import { launchWorktreeNameBase } from '../launch-placement-worktree'
import { getDefaultUserDataPath, RuntimeClientError } from '../runtime-client'
import {
  launchIntentInputs,
  launchIntentKey,
  newestLaunchRecord,
  readLaunchIntent
} from '../session-launch-intent'
import { agentLaunchRecordStore, type AgentLaunchRecord } from '../session-launch-record'
import type { LaunchInput } from './session-launch-input'
import {
  assertLaunchPlacementChosen,
  freezeLaunchPlacement,
  rankLaunchPlacement,
  type RankedLaunchPlacement
} from './session-launch-placement-plan'

/** The pick, refused before it is frozen when its repository's setup must finish first. */
export async function assertRankedSetupOrder(
  ranked: RankedLaunchPlacement,
  input: LaunchInput,
  clients: LaunchPlacementClients
): Promise<void> {
  const chosen = assertLaunchPlacementChosen(ranked, input)
  await assertPlacementSetupOrder({
    client: launchPlacementRouteClient(chosen.route, clients),
    chosen,
    provider: input.provider,
    worktreeName: launchWorktreeNameBase(input) || 'launch'
  })
}

function wouldRefuseOf(error: unknown): NonNullable<LaunchPlacementPreview['wouldRefuse']> {
  if (!(error instanceof RuntimeClientError)) {
    throw error
  }
  // Why: like a PR 1 dry run, a refusal exits 0 and says what the launch would refuse.
  return { code: error.code, message: error.message, data: error.data }
}

/** No frozen pick: read every computer, rank them and check the pick, as a first run would. */
async function rankedPlacementPreview(
  ctx: Pick<HandlerContext, 'flags'>,
  input: LaunchInput,
  clients: LaunchPlacementClients
): Promise<LaunchPlacementPreview> {
  const ranked = await rankLaunchPlacement({ flags: ctx.flags, input, clients })
  const candidates = ranked.ranking.candidates.map(launchCandidateSummary)
  let placement: LaunchPlacement | null = null
  let wouldRefuse: LaunchPlacementPreview['wouldRefuse'] = null
  try {
    placement = freezeLaunchPlacement(ranked, input, null)
    await assertRankedSetupOrder(ranked, input, clients)
  } catch (error) {
    wouldRefuse = wouldRefuseOf(error)
  }
  return { launched: false, operationId: null, placement, candidates, wouldRefuse, continues: null }
}

/** The record a real run of this command would follow (read-only), or null when it would rank. */
function frozenLaunchRecord(
  ctx: Pick<HandlerContext, 'flags' | 'cwd'>,
  input: LaunchInput
): AgentLaunchRecord | null {
  if (input.again) {
    return null
  }
  const store = agentLaunchRecordStore(getDefaultUserDataPath())
  const intentKey = launchIntentKey(launchIntentInputs(ctx.flags, ctx.cwd, input.prompt))
  const intentOperationId = readLaunchIntent(store, intentKey)
  const found = intentOperationId ? store.read(intentOperationId) : null
  return found ? newestLaunchRecord(found, (operationId) => store.read(operationId)) : null
}

/**
 * Why: a real re-run follows this command's frozen record and never ranks again, so its preview
 * shows that frozen pick (or the refusal following it would meet), not a fresh ranking.
 */
async function placementPreview(
  ctx: Pick<HandlerContext, 'flags' | 'cwd'>,
  input: LaunchInput,
  clients: LaunchPlacementClients
): Promise<LaunchPlacementPreview> {
  const refused = (
    error: unknown,
    continues: LaunchPlacementPreview['continues']
  ): LaunchPlacementPreview => ({
    launched: false,
    operationId: null,
    placement: null,
    candidates: [],
    wouldRefuse: wouldRefuseOf(error),
    continues
  })
  let frozen: AgentLaunchRecord | null
  try {
    frozen = frozenLaunchRecord(ctx, input)
  } catch (error) {
    return refused(error, null)
  }
  if (!frozen) {
    return await rankedPlacementPreview(ctx, input, clients)
  }
  const continues = { operationId: frozen.operationId, outcome: frozen.outcome }
  if (!frozen.placement) {
    return refused(noLaunchPlacementRefusal(frozen), continues)
  }
  const { placement } = frozen
  return {
    launched: false,
    operationId: null,
    placement,
    candidates: placement.candidates,
    wouldRefuse: null,
    continues
  }
}

export async function printPlacementDryRun(
  ctx: Pick<HandlerContext, 'flags' | 'cwd' | 'json'>,
  input: LaunchInput,
  clients: LaunchPlacementClients
): Promise<void> {
  const preview = await placementPreview(ctx, input, clients)
  printResult(
    { id: 'dry-run', ok: true, result: preview, _meta: { runtimeId: 'unknown' } },
    ctx.json,
    (value) => formatLaunchPlacementPreview(value, input.provider)
  )
}
