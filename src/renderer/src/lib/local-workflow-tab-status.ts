import type { AgentDotState } from '@/components/AgentStateDot'
import type { TabStateDotState } from '@/components/tab-bar/TabStateDot'
import {
  workflowAnchorKind,
  workflowPresetLabel,
  type WorkflowKind
} from '@/components/local-workflows/workflow-presets'
import { translate } from '@/i18n/i18n'
import type {
  BuildReviewPipelineSnapshot,
  BuildReviewStage
} from '../../../shared/build-review-pipeline'
import type { LocalWorkflowChangedEvent } from '../../../shared/local-workflow-rpc'
import { buildReviewRunState, localWorkflowRunState } from '../../../shared/session-workflow-anchor'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { LocalWorkflowHydrationOutcome } from '@/store/slices/local-workflow-status'
import type { ConversationState } from './conversation-state'

type LocalWorkflowTab = NonNullable<TerminalTab['localWorkflow']>
/**
 * 'unknown': a started run whose state has not arrived yet (its read is under way). 'needs-you':
 * the run waits on the person (paused, out of budget, needing recovery, or a worker's question).
 * 'missing': the controller that owns the run has no such run ("run not found"). 'unavailable':
 * the run's state could not be read ("status unavailable"). Neither of the last two is a draft,
 * a pending launch, completion or cancellation.
 */
export type LocalWorkflowTabStatus =
  | 'draft'
  | 'unknown'
  | 'running'
  | 'needs-you'
  | 'done'
  | 'failed'
  | 'stopped'
  | 'missing'
  | 'unavailable'

/** What a sidebar row needs to show a workflow conversation; carried on SidebarSession. */
export type SidebarWorkflow = {
  preset: WorkflowKind
  status: LocalWorkflowTabStatus
  phase?: string
  origin?: 'cli' | 'benchmark'
  /** The machine the run was placed on, shown on the row; never decides its host scope. */
  host?: string
  /** Worker transport identity, separate from the conversation controller. */
  sshHost?: string
  /** The run the anchor started (execution, Evolve run or pipeline id); absent before it exists. */
  runId?: string
}

function buildReviewPhase(stage: BuildReviewStage): string | undefined {
  switch (stage) {
    case 'starting':
      return translate('localWorkflow.tabStatus.starting', 'Starting')
    case 'building':
      return translate('localWorkflow.tabStatus.building', 'Building')
    case 'reviewing':
      return translate('localWorkflow.tabStatus.reviewing', 'Reviewing')
    case 'completed':
    case 'failed':
    case 'cancelled':
      return undefined
  }
}

/** A read that found no run, or failed, for exactly this run; otherwise its state is still coming. */
function unreadStatus(
  runId: string,
  hydration: LocalWorkflowHydrationOutcome | undefined
): LocalWorkflowTabStatus {
  if (hydration?.runId !== runId) {
    return 'unknown'
  }
  return hydration.outcome === 'missing' ? 'missing' : 'unavailable'
}

/** Phase titles the Council and Discover programs report, in the reader's language. */
const PHASE_LABELS = new Map<string, () => string>([
  ['First opinions', () => translate('localWorkflow.tabStatus.firstOpinions', 'First opinions')],
  ['Peer rankings', () => translate('localWorkflow.tabStatus.peerRankings', 'Peer rankings')],
  ['Chairman', () => translate('localWorkflow.tabStatus.chairman', 'Chairman')],
  ['Scout', () => translate('localWorkflow.tabStatus.scout', 'Scout')],
  ['Find', () => translate('localWorkflow.tabStatus.find', 'Find')],
  ['Verify', () => translate('localWorkflow.tabStatus.verify', 'Verify')],
  ['Rank', () => translate('localWorkflow.tabStatus.rank', 'Rank')],
  ['Answers', () => translate('localWorkflow.tabStatus.answers', 'Answers')],
  ['Peer review', () => translate('localWorkflow.tabStatus.peerReview', 'Peer review')],
  ['Synthesis', () => translate('localWorkflow.tabStatus.synthesis', 'Synthesis')],
  ['Discover', () => translate('localWorkflow.tabStatus.discover', 'Discover')],
  [
    'Root-cause review',
    () => translate('localWorkflow.tabStatus.rootCauseReview', 'Root-cause review')
  ],
  [
    'Skeptical review',
    () => translate('localWorkflow.tabStatus.skepticalReview', 'Skeptical review')
  ]
])

/** A known phase translated; an unknown one (a newer program) is shown as the host sent it. */
export function localWorkflowPhaseLabel(phase: string): string {
  return PHASE_LABELS.get(phase)?.() ?? phase
}

/**
 * A workflow tab's real state: Build + Review from its pipeline, Council and Discover from the
 * pushed or hydrated host status. A status for another execution of the same tab is ignored.
 * `pipelinesListed`: the host has listed its runs, so a run missing from them is one it no longer
 * has ("run not found"), not one whose state is still coming. `hydration`: the stored outcome of
 * reading this tab's run when no status came back.
 */
export function localWorkflowSidebarWorkflow(
  workflow: LocalWorkflowTab,
  status: LocalWorkflowChangedEvent | undefined,
  pipelines: Readonly<Record<string, BuildReviewPipelineSnapshot>> | undefined,
  pipelinesListed = false,
  hydration?: LocalWorkflowHydrationOutcome
): SidebarWorkflow {
  const { preset } = workflow
  if (preset === 'build-review') {
    const runId = workflow.buildReviewPipelineId
    if (!runId) {
      return { preset, status: 'draft' }
    }
    const pipeline = pipelines?.[runId]
    if (!pipeline) {
      return { preset, runId, status: pipelinesListed ? 'missing' : unreadStatus(runId, hydration) }
    }
    const status = buildReviewRunState(pipeline)
    const phase = status === 'running' ? buildReviewPhase(pipeline.stage) : undefined
    const host = pipeline.placement?.host?.name
    return { preset, runId, status, ...(phase ? { phase } : {}), ...(host ? { host } : {}) }
  }
  const kind = workflowAnchorKind(workflow)
  const runId = workflow.executionId
  const current = status && (!runId || status.executionId === runId) ? status : undefined
  if (current) {
    return {
      preset: kind,
      ...(runId ? { runId } : {}),
      status: localWorkflowRunState(current.state),
      ...(current.phase ? { phase: current.phase } : {}),
      ...(current.host ? { host: current.host } : {}),
      ...(current.sshHost ? { sshHost: current.sshHost } : {})
    }
  }
  if (runId) {
    return { preset: kind, runId, status: unreadStatus(runId, hydration) }
  }
  // A Start in flight is already work; its first push follows within a second.
  return { preset: kind, status: workflow.startRequest ? 'running' : 'draft' }
}

export function localWorkflowTabStatus(
  workflow: LocalWorkflowTab,
  status: LocalWorkflowChangedEvent | undefined,
  pipelines: Readonly<Record<string, BuildReviewPipelineSnapshot>> | undefined,
  pipelinesListed = false,
  hydration?: LocalWorkflowHydrationOutcome
): LocalWorkflowTabStatus {
  return localWorkflowSidebarWorkflow(workflow, status, pipelines, pipelinesListed, hydration)
    .status
}

/**
 * Sidebar fields for a pending or workflow tab. A started workflow is real work with a real
 * state; only a draft (never started) is a pending launch. A run whose state is still being read,
 * was not found or could not be read is a started run, never a pending launch (C6).
 */
export function workflowSidebarRowFields(
  tab: Pick<TerminalTab, 'id' | 'localWorkflow'>,
  source: {
    localWorkflowStatusByTabId?: Readonly<Record<string, LocalWorkflowChangedEvent>>
    localWorkflowHydrationByTabId?: Readonly<Record<string, LocalWorkflowHydrationOutcome>>
    buildReview?: {
      pipelinesById: Readonly<Record<string, BuildReviewPipelineSnapshot>>
      pipelinesListed?: boolean
    }
  }
): { launchPending?: true; agent: string; workflow?: SidebarWorkflow } {
  if (!tab.localWorkflow) {
    return { launchPending: true, agent: 'Agent' }
  }
  const workflow = localWorkflowSidebarWorkflow(
    tab.localWorkflow,
    source.localWorkflowStatusByTabId?.[tab.id],
    source.buildReview?.pipelinesById,
    source.buildReview?.pipelinesListed,
    source.localWorkflowHydrationByTabId?.[tab.id]
  )
  return {
    ...(workflow.status === 'draft' ? { launchPending: true as const } : {}),
    agent: workflowPresetLabel(workflow.preset),
    workflow: {
      ...workflow,
      ...(tab.localWorkflow.launch ? { origin: tab.localWorkflow.launch.origin } : {})
    }
  }
}

/** The agent-hook vocabulary, for the dot beside a preset icon. Unsettled drafts show no dot. */
export function localWorkflowDotState(status: LocalWorkflowTabStatus): AgentDotState | null {
  switch (status) {
    case 'running':
      return 'working'
    case 'needs-you':
      return 'waiting'
    case 'done':
      return 'done'
    case 'failed':
      return 'failed'
    case 'stopped':
      return 'interrupted'
    case 'draft':
    case 'unknown':
    case 'missing':
    case 'unavailable':
      return null
  }
}

/** A started run whose state this window cannot show: still being read, not found or unreadable. */
export function localWorkflowStatusUnverified(status: LocalWorkflowTabStatus | undefined): boolean {
  return status === 'unknown' || status === 'missing' || status === 'unavailable'
}

/** A run that waits on the person (to resume, recover or answer) is filed as needing them. */
export function localWorkflowNeedsYou(workflow: SidebarWorkflow | undefined): boolean {
  return workflow?.status === 'needs-you'
}

/** The sidebar row glyph. */
export function localWorkflowConversationState(status: LocalWorkflowTabStatus): ConversationState {
  switch (status) {
    case 'running':
      return 'working'
    case 'needs-you':
      return 'needs-you'
    case 'done':
      return 'done'
    case 'failed':
      return 'failed'
    case 'stopped':
      return 'interrupted'
    case 'draft':
    case 'unknown':
      return 'inactive'
    case 'missing':
    case 'unavailable':
      return 'unverifiable'
  }
}

/** The strip's edge dot: only live work or a run waiting on the person announces itself. */
export function localWorkflowTabStateDot(status: LocalWorkflowTabStatus): TabStateDotState | null {
  return status === 'running' ? 'running' : status === 'needs-you' ? 'needs-you' : null
}

/**
 * "Council", or "Council · Peer rankings" while it runs, then the machine it was placed on, as a
 * fleet dispatch row captions it; translated when the row renders.
 */
export function localWorkflowAgentLine(workflow: SidebarWorkflow): string {
  const label = workflowPresetLabel(workflow.preset)
  const phase =
    workflow.status === 'running' && workflow.phase
      ? localWorkflowPhaseLabel(workflow.phase)
      : workflow.status === 'missing'
        ? translate('localWorkflow.tabStatus.runNotFound', 'run not found')
        : workflow.status === 'unavailable'
          ? translate('localWorkflow.tabStatus.statusUnavailable', 'status unavailable')
          : undefined
  return [label, phase, workflow.host].filter(Boolean).join(' · ')
}
