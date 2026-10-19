import { useAppStore } from '@/store'
import { workflowModelClient } from './workflow-model-client'
import { canonicalJson } from '../../../shared/decision-contracts/decision-calibration-summary'
import type { LocalWorkflowLaunch } from '../../../shared/local-workflow-launch'
import type { WorkflowRunsOn } from '../../../shared/local-workflow-placement'
import { replayWorkflowLaunch, workflowLaunchAnchor } from './local-workflow-launch-replay'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import {
  createLocalWorkflowGraphDraft,
  type LocalWorkflowLaunchChoice
} from '../../../shared/local-workflow-draft'
import {
  localWorkflowRunSpec,
  type LocalWorkflowRunRequest
} from '../../../shared/local-workflow-run-request'
import {
  LOCAL_WORKFLOW_METHODS,
  type LocalWorkflowSetupResult,
  type LocalWorkflowStartResult
} from '../../../shared/local-workflow-rpc'
import {
  WORKFLOW_ROUTES,
  type WorkflowRoute,
  type WorkflowSpec
} from '../../../shared/workflow-graph'
import type { WorkflowKind } from '@/components/local-workflows/workflow-presets'
import {
  createLocalWorkflowConversation,
  persistLocalWorkflowConversationAnchor,
  titleLocalWorkflowConversation,
  updateLocalWorkflowConversation
} from './local-workflow-conversation'

export type LocalWorkflowGraphStart = {
  kind: WorkflowKind
  prompt: string
  /** The spec over the families that take seats; it throws to refuse the request. */
  spec: (routes: readonly WorkflowRoute[]) => WorkflowSpec
  /** Only these families take seats; absent means every family the host lists. */
  routes?: readonly WorkflowRoute[]
  /** Where the run executes; absent means the fleet, the default of every preset. */
  runsOn?: WorkflowRunsOn
  /** `--host`, `--force-host`, `--requested-by`, `--request`, carried into the draft as given. */
  choice?: LocalWorkflowLaunchChoice
  /** No cross-run known list: `--no-earlier-runs`, and every benchmark run. */
  skipEarlierRuns?: true
  focusFinding?: string
  /** `--budget-root`: the approved budget root this run spends. */
  budgetRootId?: string
  launch?: LocalWorkflowLaunch
}

/**
 * A workflow the CLI asked for: opens a background conversation in the workspace and starts it
 * the way Start does, so the run is anchored to a real conversation the person can open. A run
 * that cannot start leaves the conversation with its settings, for the person to fix and start.
 */
export function startLocalWorkflowGraphConversation(
  worktreeId: string,
  start: LocalWorkflowGraphStart
): Promise<{ conversationId: string; executionId: string }> {
  return replayWorkflowLaunch(worktreeId, start.launch, () => launchGraph(worktreeId, start))
}

async function launchGraph(
  worktreeId: string,
  start: LocalWorkflowGraphStart
): Promise<{ conversationId: string; executionId: string }> {
  // A request that cannot be built opens nothing. Structure only: availability is checked
  // against the team the host lists, below.
  start.spec(start.routes?.length ? start.routes : WORKFLOW_ROUTES)
  const preset = start.kind === 'discover' ? 'discover' : 'council'
  const previous = workflowLaunchAnchor(worktreeId, start.launch)
  if (previous?.localWorkflow?.executionId) {
    return { conversationId: previous.id, executionId: previous.localWorkflow.executionId }
  }
  const conversationId =
    previous?.id ??
    createLocalWorkflowConversation(worktreeId, start.kind, {
      background: true,
      ...(start.launch ? { launch: start.launch } : {})
    })
  updateLocalWorkflowConversation(worktreeId, conversationId, { prompt: start.prompt })
  await persistLocalWorkflowConversationAnchor(worktreeId, conversationId)
  const address = { worktree: toRuntimeWorktreeSelector(worktreeId), conversationId }
  const saved = previous?.localWorkflow?.startRequest
  const setup = saved
    ? null
    : await callRuntimeRpc<LocalWorkflowSetupResult>(
        { kind: 'local' },
        LOCAL_WORKFLOW_METHODS.setup,
        { ...address, preset }
      )
  const listed = saved?.draft.graph?.team ?? setup?.graphTeam ?? []
  const team = start.routes ? listed.filter((seat) => start.routes!.includes(seat.agent)) : listed
  const missing = (start.routes ?? []).filter(
    (route) => !listed.some((seat) => seat.agent === route)
  )
  if (setup?.unavailableReason || !team.length || missing.length) {
    // Only discard an empty anchor created here; a replay keeps its persisted recovery state.
    if (!previous) {
      useAppStore.getState().closeTab(conversationId)
    }
    throw new Error(
      setup?.unavailableReason ??
        (missing.length
          ? `Not set up for workflows on this computer: ${missing.join(', ')}.`
          : 'No model is set up for workflows on this computer.')
    )
  }
  let spec: WorkflowSpec
  try {
    spec = start.spec(team.map((seat) => seat.agent))
  } catch (error) {
    if (!previous) {
      useAppStore.getState().closeTab(conversationId)
    }
    throw error
  }
  const draft =
    saved?.draft ??
    createLocalWorkflowGraphDraft({
      prompt: start.prompt,
      graph: { spec, team: [...team] },
      ...(start.runsOn ? { runsOn: start.runsOn } : {}),
      ...(start.focusFinding ? { focusFinding: start.focusFinding } : {}),
      ...(start.skipEarlierRuns ? { skipEarlierRuns: true } : {}),
      ...(start.budgetRootId ? { budgetRootId: start.budgetRootId } : {}),
      ...start.choice
    })
  const pending = saved ?? { requestId: start.launch?.operationId ?? crypto.randomUUID(), draft }
  updateLocalWorkflowConversation(worktreeId, conversationId, {
    startRequest: pending,
    draft,
    prompt: start.prompt
  })
  await persistLocalWorkflowConversationAnchor(worktreeId, conversationId)
  const result = await callRuntimeRpc<LocalWorkflowStartResult>(
    { kind: 'local' },
    LOCAL_WORKFLOW_METHODS.start,
    { ...address, preset, requestId: pending.requestId, draft }
  )
  if ('rejected' in result) {
    updateLocalWorkflowConversation(worktreeId, conversationId, { startRequest: undefined })
    throw new Error(result.reason)
  }
  updateLocalWorkflowConversation(worktreeId, conversationId, {
    executionId: result.executionId,
    startRequest: undefined
  })
  titleLocalWorkflowConversation(conversationId, start.prompt)
  await persistLocalWorkflowConversationAnchor(worktreeId, conversationId)
  return { conversationId, executionId: result.executionId }
}

/** `omni workflow run`: any built-in template, started as Find the best is. */
export async function startLocalWorkflowRunConversation(
  worktreeId: string,
  request: LocalWorkflowRunRequest
): Promise<{ conversationId: string; executionId: string }> {
  // `--models cheap` means this person's Cheap lineup; a host without tiers uses the built-in ones.
  const tiers = request.models
    ? await workflowModelClient
        .tiers()
        .then((state) => state.tiers)
        .catch(() => undefined)
    : undefined
  return startLocalWorkflowGraphConversation(worktreeId, {
    kind: request.template,
    prompt: request.prompt,
    spec: (routes) => localWorkflowRunSpec(request, routes, tiers),
    ...(request.operationId
      ? {
          launch: {
            operationId: request.operationId,
            origin: request.origin ?? 'cli',
            request: canonicalJson(request)
          }
        }
      : {}),
    ...(request.routes ? { routes: request.routes } : {}),
    ...(request.runsOn ? { runsOn: request.runsOn } : {}),
    ...(request.focusFinding ? { focusFinding: request.focusFinding } : {}),
    ...(request.budgetRoot ? { budgetRootId: request.budgetRoot } : {}),
    // A benchmark rep must not be told what the previous rep found.
    ...(request.skipEarlierRuns || request.origin === 'benchmark'
      ? { skipEarlierRuns: true as const }
      : {}),
    choice: {
      ...(request.host ? { runsOnHost: request.host } : {}),
      ...(request.forceHost ? { forceHost: request.forceHost } : {}),
      ...(request.requestedBy ? { requestedBy: request.requestedBy } : {}),
      ...(request.requestedById ? { requestedById: request.requestedById } : {}),
      ...(request.request ? { request: request.request } : {})
    }
  })
}
