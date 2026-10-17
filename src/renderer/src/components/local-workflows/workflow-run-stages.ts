import { translate } from '@/i18n/i18n'
import type {
  LocalWorkflowCallView,
  LocalWorkflowView
} from '../../../../shared/local-workflow-view'

/** stopped: the run ended (Stop) while this stage had started but not finished. */
export type WorkflowStageTone = 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'stopped'
export type WorkflowStageModel = {
  id: string
  index: number
  label: string
  calls: LocalWorkflowCallView[]
  completed: number
  failed: number
  total: number
  tone: WorkflowStageTone
  /** Karpathy-style line while the stage works, e.g. "Collecting individual responses…". */
  activeLine: string
}

const ACTIVE_RUN = new Set<LocalWorkflowView['state']>(['running', 'stopping'])
const HELD_RUN = new Set<LocalWorkflowView['state']>([
  'pausing',
  'paused',
  'budget_paused',
  'recovery_required'
])
const ENDED_RUN = new Set<LocalWorkflowView['state']>(['completed', 'cancelled', 'failed'])

function councilStageText(index: number, fallback: string): { label: string; line: string } {
  switch (index) {
    case 0:
      return {
        label: translate('localWorkflow.run.councilStage1', 'First opinions'),
        line: translate('localWorkflow.run.councilStage1Line', 'Collecting individual responses…')
      }
    case 1:
      return {
        label: translate('localWorkflow.run.councilStage2', 'Peer rankings'),
        line: translate('localWorkflow.run.councilStage2Line', 'Models are ranking the answers…')
      }
    case 2:
      return {
        label: translate('localWorkflow.run.councilStage3', "Chairman's answer"),
        line: translate('localWorkflow.run.councilStage3Line', 'Writing the final answer…')
      }
    default:
      return { label: fallback, line: translate('localWorkflow.run.working', 'Working…') }
  }
}

/** Revision 7 ids are scout/find/verify/rank; older runs (1-6) used discover/refute/rank. */
function discoverStageText(id: string, fallback: string): { label: string; line: string } {
  switch (id) {
    case 'scout':
      return {
        label: translate('localWorkflow.run.scout', 'Scout'),
        line: translate('localWorkflow.run.scoutLine', 'Mapping where to look…')
      }
    case 'find':
    case 'discover':
      return {
        label: translate('localWorkflow.run.find', 'Find'),
        line: translate('localWorkflow.run.findLine', 'Searching for defects…')
      }
    case 'verify':
    case 'refute':
      return {
        label: translate('localWorkflow.run.verify', 'Verify'),
        line: translate('localWorkflow.run.verifyLine', 'Trying to refute each finding…')
      }
    case 'rank':
      return {
        label: translate('localWorkflow.run.rank', 'Rank'),
        line: translate('localWorkflow.run.rankLine', 'Ranking what held up by blast radius…')
      }
    default:
      return { label: fallback, line: translate('localWorkflow.run.working', 'Working…') }
  }
}

export function workflowStageCalls(
  view: LocalWorkflowView,
  stageId: string
): LocalWorkflowCallView[] {
  // Legacy Discover ran root-cause "cluster" calls inside its first stage.
  return view.calls.filter(
    (call) => call.stageId === stageId || (stageId === 'discover' && call.stageId === 'cluster')
  )
}

function stageTone(
  view: LocalWorkflowView,
  calls: readonly LocalWorkflowCallView[],
  counts: { completed: number; failed: number; total: number },
  laterStarted: boolean
): WorkflowStageTone {
  const active = calls.some((call) => call.state === 'running' || call.state === 'queued')
  if (active && !ENDED_RUN.has(view.state)) {
    return HELD_RUN.has(view.state) ? 'paused' : 'running'
  }
  const settled = calls.length > 0 && counts.completed + counts.failed >= counts.total
  if (settled || laterStarted || (view.state === 'completed' && !calls.length)) {
    return counts.completed === 0 && counts.failed > 0 ? 'failed' : 'done'
  }
  // Any call or accepted result means the stage started, even if the run then stopped or paused.
  if (!calls.length && counts.completed + counts.failed === 0) {
    return 'queued'
  }
  if (ACTIVE_RUN.has(view.state)) {
    // Some work landed and more is expected (another Discover round, say).
    return 'running'
  }
  if (HELD_RUN.has(view.state)) {
    return 'paused'
  }
  if (view.state === 'completed') {
    return 'done'
  }
  return calls.some((call) => call.state === 'failed') ? 'failed' : 'stopped'
}

/** The rail: one model per stage with its calls, counts, tone and live line. */
export function workflowStages(view: LocalWorkflowView): WorkflowStageModel[] {
  const stages = view.stages.map((stage) => ({ stage, calls: workflowStageCalls(view, stage.id) }))
  return stages.map(({ stage, calls }, index) => {
    // Progress numbers come from the host, which knows what a stage is still owed.
    const { completed, failed } = stage
    const total = stage.total ?? calls.length
    const laterStarted = stages.slice(index + 1).some((later) => later.calls.length > 0)
    const text =
      view.preset === 'council'
        ? councilStageText(index, stage.label)
        : discoverStageText(stage.id, stage.label)
    return {
      id: stage.id,
      index,
      label: text.label,
      calls,
      completed,
      failed,
      total,
      tone: stageTone(view, calls, { completed, failed, total }, laterStarted),
      activeLine: text.line
    }
  })
}
