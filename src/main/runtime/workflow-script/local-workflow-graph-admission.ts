import { readDiscoverRunSource } from './discover-run-source'
import { graphDiscoverVerifyAdmission } from './graph/graph-discover-rules'
import type { LocalWorkflowStartRequest } from '../../../shared/local-workflow-rpc'
import {
  localWorkflowRouteNamesModel,
  streamedLocalWorkflowCatalog,
  type LocalWorkflowSeatCatalog
} from '../../../shared/local-workflow-seats'
import { localWorkflowProviderLabel } from '../../../shared/local-workflow-model-label'
import {
  WORKFLOW_MAX_CALLS,
  WORKFLOW_ROUTES,
  type WorkflowRoute,
  type WorkflowSpec
} from '../../../shared/workflow-graph'
import { normalizeWorkflowSpec } from '../../../shared/workflow-graph-normalize'
import {
  planWorkflowCalls,
  workflowFinalStep,
  workflowFinishReserve
} from '../../../shared/workflow-graph-topology'
import { validateWorkflowSpec } from '../../../shared/workflow-graph-validate'
import { workflowReadsWeb } from '../../../shared/workflow-graph-web'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'
import type {
  LocalWorkflowFrozenScope,
  LocalWorkflowWorkspace
} from './local-workflow-host-options'
import { GRAPH_PROGRAM_REVISION } from './workflow-program-revisions'
import { admitGraphSeatRules, resolveGraphSeats } from './local-workflow-graph-seat-admission'
import { admitImproveFrontierSeats } from './local-workflow-graph-frontier-admission'
import { FIND_RULES } from './graph/graph-plan-types'
import { IMPROVE_RULES } from './graph/graph-improve-rules'
import { WEB_RULES } from './graph/graph-web-types'
import { graphDecisionAdmission } from './graph/graph-decision-rules'
import { graphEvidenceAdmission } from './graph/graph-pre-verify'
import { admitWorkingAgentGitSource } from './workflow-working-source-admission'
import { admitQuickDiscoverScope, quickDiscoverSelection } from './quick-discover-bundle'
import { QUICK_DISCOVER_FIND_STEP } from '../../../shared/workflow-graph-quick-discover'
import {
  admitWorkflowContext,
  type WorkflowContextMaterializer
} from './local-workflow-context-admission'

/** Every graph call may use every persisted attempt; two run inside one run, one is left for Retry. */
const GRAPH_ATTEMPT_LIMIT = 3
const MAX_PROMPT_CHARS = 32_000

export type LocalWorkflowGraphAdmission = {
  snapshot: LocalWorkflowHostSnapshot
  callLimit: number
  attemptLimit: number
  budgetLimit: number
  /** The durable preset column; graph runs are recognised by their snapshot, not this tag. */
  preset: 'council' | 'discover'
  /** The run's private context folder, removed if the Start is refused after admission. */
  contextRoot?: string
}

/**
 * Admission for a workflow graph: the host normalizes and validates the spec against the routes
 * this computer can run right now, resolves every agent to a verified seat, and freezes the spec,
 * the seats and the task into the run's snapshot. A graph the validator refuses never starts.
 */
/** Max agents lowers the call limit; the final step's calls always stay within it. */
function cappedCallLimit(spec: WorkflowSpec, planned: number, maxAgents?: number): number {
  if (maxAgents === undefined) {
    return planned
  }
  const finish = workflowFinishReserve(spec)
  if (!finish) {
    throw new Error('Max agents needs a workflow that ends in one final step outside its loop.')
  }
  if (!Number.isInteger(maxAgents) || maxAgents <= finish.reserve) {
    throw new Error(
      `Max agents must be at least ${finish.reserve + 1}, to leave room for the report.`
    )
  }
  return Math.min(planned, maxAgents)
}

/**
 * A change to the code is tested in private copies of one clean commit: the workspace must be a
 * Git repository's top folder with nothing uncommitted, or the copies would test other code.
 */
async function admitCodeChanges(workspacePath: string): Promise<{ sourceBase: string }> {
  const { sourceBase } = await admitWorkingAgentGitSource(workspacePath, {
    unavailable:
      'A change to your code is tested in a private copy of a Git repository with at least one commit, and this workspace is not one. Choose "Text" for what each version is.',
    notRoot: "A change to your code needs the Git repository's top folder as the workspace.",
    noCommit: 'A change to your code needs a Git repository with at least one commit.',
    dirty:
      'A change to your code is tested on your last commit, and this workspace has uncommitted or untracked changes. Commit or stash them, then start again.'
  })
  return { sourceBase }
}

/**
 * The folder agents read (the workspace, or the run's context folder) and, for Find the best, the
 * workspace its results are saved in, which is always the real one.
 */
async function admittedRoots(
  input: { freezeWorkspaceRoot: (path: string) => Promise<LocalWorkflowFrozenRoot> },
  roots: { read: boolean; path: string; results?: string }
): Promise<{ workspaceRoot?: LocalWorkflowFrozenRoot; resultsRoot?: LocalWorkflowFrozenRoot }> {
  const workspaceRoot = roots.read ? await input.freezeWorkspaceRoot(roots.path) : undefined
  const resultsRoot = !roots.results
    ? undefined
    : workspaceRoot && roots.results === roots.path
      ? workspaceRoot
      : await input.freezeWorkspaceRoot(roots.results)
  return { workspaceRoot, resultsRoot }
}

type LocalWorkflowFrozenRoot = { path: string; device: string; inode: string }

export async function prepareGraphWorkflowAdmission(input: {
  request: LocalWorkflowStartRequest
  workspace: LocalWorkflowWorkspace
  requestDigest: string
  slotLimit: number
  catalog: () => Promise<LocalWorkflowSeatCatalog[]>
  freezeScope: (
    workspace: LocalWorkflowWorkspace,
    ids: string[]
  ) => Promise<LocalWorkflowFrozenScope>
  freezeWorkspaceRoot: (path: string) => Promise<LocalWorkflowFrozenRoot>
  /** Copies chosen files, folders and repos into one private folder; absent, none are allowed. */
  materializeContext?: WorkflowContextMaterializer
  discardContext?: (root: string) => Promise<void>
  /** Quick Discover's whole-scope bundle; tests replace the file reads. */
  bundleQuickScope?: typeof admitQuickDiscoverScope
}): Promise<LocalWorkflowGraphAdmission> {
  const { request, workspace } = input
  const draft = request.draft
  const graph = draft.graph!
  if (!draft.prompt.trim() || draft.prompt.length > MAX_PROMPT_CHARS) {
    throw new Error('Enter a workflow prompt of at most 32,000 characters.')
  }
  if (
    !Number.isInteger(draft.concurrency) ||
    draft.concurrency < 1 ||
    draft.concurrency > input.slotLimit
  ) {
    throw new Error('Invalid workflow limits.')
  }
  // Graph calls answer in text or stream a structured result, so only streamable routes count.
  const catalog = streamedLocalWorkflowCatalog(await input.catalog())
  const available = WORKFLOW_ROUTES.filter((route: WorkflowRoute) =>
    catalog.some(
      (entry) => entry.agent === route && !entry.unavailableReason && entry.models.length
    )
  )
  let spec = normalizeWorkflowSpec(graph.spec)
  const { problems } = validateWorkflowSpec(spec, { available })
  if (spec.template === 'build-review') {
    problems.push({ message: 'Build + Review runs through its own executor, not this one.' })
  }
  const admitted = admitWorkflowContext({
    draft,
    workspace,
    hasCheck: !!(spec.repeat?.check || spec.find?.check)
  })
  problems.push(...admitted.problems.map((message) => ({ message })))
  if (admitted.context && !input.materializeContext) {
    problems.push({ message: 'This computer cannot copy chosen files, folders and repos.' })
  }
  // The app reads pages where it runs, so a run executing elsewhere must never read them here.
  const readsWeb = workflowReadsWeb(spec)
  if (readsWeb && workspace.executionHost !== 'local') {
    problems.push({ message: 'Reading web pages needs a workspace that runs on this computer.' })
  }
  if (problems.length) {
    throw new Error(problems.map((problem) => problem.message).join(' '))
  }
  let quickScope: LocalWorkflowFrozenScope | undefined
  const quick = quickDiscoverSelection(spec, available)
  if (quick && draft.scopeIds.length && draft.access !== 'frozen' && !admitted.context) {
    const candidate = resolveGraphSeats(quick, graph.team, catalog)
    try {
      quickScope = await (input.bundleQuickScope ?? admitQuickDiscoverScope)({
        workspace,
        scopeIds: draft.scopeIds,
        seat: candidate.seats.find(
          (seat) => seat.id === candidate.agentSeats[QUICK_DISCOVER_FIND_STEP]?.[0]
        ),
        promptChars: draft.prompt.length
      })
      spec = quick
    } catch {
      // A scope that cannot be read whole keeps the ordinary Discover path.
    }
  }
  const resolved = resolveGraphSeats(spec, graph.team, catalog)
  const { agentSeats } = resolved
  const { seats, frontierSeats } = admitImproveFrontierSeats(spec, graph.team, catalog, resolved)
  if (draft.access !== 'frozen') {
    for (const seat of seats) {
      if (
        localWorkflowRouteNamesModel(seat.agent) &&
        !catalog
          .find((entry) => entry.agent === seat.agent && entry.accountId === seat.accountId)
          ?.models.find((model) => model.resolvedModelId === seat.model)?.supportsTools
      ) {
        throw new Error(
          `${localWorkflowProviderLabel(seat.agent)} model ${seat.model} does not support tools. Choose Knowledge only or a model with tools.`
        )
      }
    }
  }
  const plan = planWorkflowCalls(spec)
  const planned = plan.total
  if (planned < 1 || planned > WORKFLOW_MAX_CALLS) {
    throw new Error(
      plan.hostTotal
        ? `This workflow needs ${plan.agentTotal} agent calls and ${plan.hostTotal} host calls ` +
            `(${planned} total); at most ${WORKFLOW_MAX_CALLS} are allowed.`
        : `This workflow needs ${planned} agent calls; at most ${WORKFLOW_MAX_CALLS} are allowed.`
    )
  }
  const callLimit = cappedCallLimit(spec, planned, graph.maxAgents)
  const final = workflowFinalStep(spec)!
  const checkSource =
    spec.repeat?.check?.apply === 'patch' ? await admitCodeChanges(workspace.path) : undefined
  // Quick Discover attaches the whole scope to its one reader, sized to that reader's context.
  const scope =
    quickScope ??
    (spec.template === 'quick-discover'
      ? await (input.bundleQuickScope ?? admitQuickDiscoverScope)({
          workspace,
          scopeIds: draft.scopeIds,
          seat: seats.find((seat) => seat.id === agentSeats[QUICK_DISCOVER_FIND_STEP]?.[0]),
          promptChars: draft.prompt.length
        })
      : await input.freezeScope(workspace, draft.scopeIds))
  const discoverSource =
    ['discover', 'quick-discover'].includes(spec.template ?? '') &&
    draft.access !== 'frozen' &&
    !admitted.context
      ? await readDiscoverRunSource(workspace.path)
      : undefined
  // Last, so a refusal above never leaves a copy behind.
  const context = admitted.context
    ? await input.materializeContext!({ workspacePath: workspace.path, ...admitted.context })
    : undefined
  let roots: Awaited<ReturnType<typeof admittedRoots>>
  try {
    roots = await admittedRoots(input, {
      read: draft.access !== 'frozen',
      path: context?.root ?? workspace.path,
      results: spec.find ? workspace.path : undefined
    })
  } catch (error) {
    if (context) {
      await input.discardContext?.(context.root)
    }
    throw error
  }
  const { workspaceRoot, resultsRoot } = roots
  const snapshot: LocalWorkflowHostSnapshot = {
    version: 1,
    capability: { mode: 'frozen-analysis', revision: 1 },
    graphProgramRevision: GRAPH_PROGRAM_REVISION,
    graph: {
      spec,
      agentSeats,
      ...(frontierSeats ? { frontierSeats } : {}),
      ...admitGraphSeatRules(seats, catalog)
    },
    ...(workspaceRoot ? { access: 'workspace-read' as const } : {}),
    limits: { concurrency: draft.concurrency },
    task: { prompt: draft.prompt.trim(), evidence: scope.evidence },
    seats,
    // Legacy field every snapshot carries; for a graph it is the final step's seat.
    synthesizerId: agentSeats[final.id][0],
    host: {
      workspaceId: workspace.id,
      conversationId: request.conversationId,
      requestDigest: input.requestDigest,
      startedAt: Date.now(),
      improveUnresolvedRounds: true,
      improveRules: IMPROVE_RULES,
      ...graphDecisionAdmission(spec),
      ...graphEvidenceAdmission(spec, !!workspaceRoot),
      ...graphDiscoverVerifyAdmission(spec),
      ...(checkSource ? { checkSource } : {}),
      concurrency: draft.concurrency,
      sources: scope.sources,
      ...(discoverSource ? { discoverSource } : {}),
      coverage: scope.coverage,
      ...(workspaceRoot ? { workspaceRoot } : {}),
      ...(context ? { context: { entries: context.entries } } : {}),
      ...(resultsRoot ? { resultsRoot, findRules: FIND_RULES } : {}),
      ...(readsWeb ? { webRules: WEB_RULES } : {})
    }
  }
  return {
    snapshot,
    callLimit,
    attemptLimit: GRAPH_ATTEMPT_LIMIT,
    budgetLimit: callLimit * GRAPH_ATTEMPT_LIMIT,
    preset: spec.template === 'discover' ? 'discover' : 'council',
    ...(context ? { contextRoot: context.root } : {})
  }
}
