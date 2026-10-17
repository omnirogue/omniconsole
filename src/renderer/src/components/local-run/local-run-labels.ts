import { translate } from '@/i18n/i18n'
import type { AgentDotState } from '@/components/AgentStateDot'
import type {
  BuildReviewStage,
  BuildReviewWorkerStatus
} from '../../../../shared/build-review-pipeline'
import {
  SESSION_ACTION_PRESET_LABELS,
  type SessionActionPresetId
} from '../../../../shared/session-action-presets'
import type { LocalRunNodeState } from '../../../../shared/local-run-node-state'
import type { LocalRunStage } from '../../../../shared/local-run-types'

export function localRunNodeStateLabel(state: LocalRunNodeState): string {
  const labels: Record<LocalRunNodeState, string> = {
    queued: translate('auto.components.local-run.NodeState.queued', 'Queued'),
    running: translate('auto.components.local-run.NodeState.running', 'Running'),
    waiting: translate('auto.components.local-run.NodeState.waiting', 'Waiting'),
    reviewing: translate('auto.components.local-run.NodeState.reviewing', 'Reviewing'),
    'needs-input': translate('auto.components.local-run.NodeState.needsInput', 'Needs input'),
    completed: translate('auto.components.local-run.NodeState.completed', 'Completed'),
    failed: translate('auto.components.local-run.NodeState.failed', 'Failed')
  }
  return labels[state]
}

export function localRunStageLabel(stage: LocalRunStage): string {
  const labels: Record<LocalRunStage, string> = {
    created: translate('auto.components.local-run.Stage.created', 'Not started'),
    starting: translate('auto.components.local-run.Stage.starting', 'Starting'),
    running: translate('auto.components.local-run.Stage.running', 'Running'),
    completed: translate('auto.components.local-run.Stage.completed', 'Completed'),
    failed: translate('auto.components.local-run.Stage.failed', 'Failed'),
    cancelled: translate('auto.components.local-run.Stage.cancelled', 'Cancelled')
  }
  return labels[stage]
}

/** The stage of either kind of local graph: a local Run, or a Build + Review. */
export function localGraphStageLabel(stage: LocalRunStage | BuildReviewStage): string {
  const local: Record<string, string> = {
    created: translate('auto.components.local-run.Stage.created', 'Not started'),
    starting: translate('auto.components.local-run.Stage.starting', 'Starting'),
    running: translate('auto.components.local-run.Stage.running', 'Running'),
    completed: translate('auto.components.local-run.Stage.completed', 'Completed'),
    failed: translate('auto.components.local-run.Stage.failed', 'Failed'),
    cancelled: translate('auto.components.local-run.Stage.cancelled', 'Cancelled'),
    building: translate('auto.components.build-review.Status.building', 'Building'),
    reviewing: translate('auto.components.build-review.Status.reviewing', 'Reviewing')
  }
  return local[stage] ?? stage
}

/**
 * The shared agent-state glyph for a node state. `needs-input` uses the question
 * indicator because that is the one state a person has to act on; `waiting` is the
 * runner's blocked-on-a-dependency state, where nothing is executing.
 */
export function localRunNodeStateDot(state: LocalRunNodeState): AgentDotState {
  const dots: Record<LocalRunNodeState, AgentDotState> = {
    queued: 'idle',
    running: 'working',
    waiting: 'blocked',
    reviewing: 'working',
    'needs-input': 'waiting',
    completed: 'done',
    failed: 'failed'
  }
  return dots[state]
}

/** The worker status a node state corresponds to, for the shared worker card. */
export function localRunWorkerStatus(state: LocalRunNodeState): BuildReviewWorkerStatus {
  switch (state) {
    case 'completed':
      return 'succeeded'
    case 'failed':
      return 'failed'
    case 'running':
    case 'reviewing':
    case 'needs-input':
      return 'running'
    case 'queued':
    case 'waiting':
      break
  }
  return 'pending'
}

export function localRunPresetLabel(presetId: SessionActionPresetId): string {
  const labels: Record<SessionActionPresetId, string> = {
    // Work-plan-only roles fall back to their English label until a local run offers them.
    ...SESSION_ACTION_PRESET_LABELS,
    research: translate('auto.components.local-run.Preset.research', 'Research'),
    analyze: translate('auto.components.local-run.Preset.analyze', 'Analyze'),
    plan: translate('auto.components.local-run.Preset.plan', 'Plan'),
    implement: translate('auto.components.local-run.Preset.implement', 'Implement'),
    improve: translate('auto.components.local-run.Preset.improve', 'Improve'),
    synthesize: translate('auto.components.local-run.Preset.synthesize', 'Synthesize'),
    verify: translate('auto.components.local-run.Preset.verify', 'Verify'),
    review: translate('auto.components.local-run.Preset.review', 'Review')
  }
  return labels[presetId]
}
