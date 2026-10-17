import { translate } from '@/i18n/i18n'
import type { DiscoverDepth } from '../../../../shared/local-workflow-draft'
import type { LocalWorkflowRoute } from '../../../../shared/local-workflow-seats'
import type {
  LocalWorkflowCallView,
  LocalWorkflowDiscoverFinding,
  LocalWorkflowDiscoverSeverity,
  LocalWorkflowRunState
} from '../../../../shared/local-workflow-view'

// Every label is a function: translate() must not run at module load.

/** Product names, which are not translated: "Waiting for the Codex account…". */
const ROUTE_NAMES: Record<LocalWorkflowRoute, string> = {
  claude: 'Claude',
  codex: 'Codex',
  grok: 'Grok',
  gemini: 'Gemini',
  openrouter: 'OpenRouter',
  ollama: 'Ollama'
}

export function workflowRouteName(route: LocalWorkflowRoute): string {
  return ROUTE_NAMES[route]
}

export function discoverLensLabel(lens: string): string {
  switch (lens) {
    case 'correctness':
      return translate('localWorkflow.lens.correctness', 'Correctness')
    case 'reliability':
      return translate('localWorkflow.lens.reliability', 'Reliability')
    case 'security':
      return translate('localWorkflow.lens.security', 'Security')
    case 'performance':
      return translate('localWorkflow.lens.performance', 'Performance')
    case 'user-path':
      return translate('localWorkflow.lens.userPath', 'User path')
    case 'data-integrity':
      return translate('localWorkflow.lens.dataIntegrity', 'Data integrity')
    default:
      return lens
  }
}

/** Verifier lenses are not user-chosen; they explain what each vote checked. */
export function verifyLensLabel(lens: string): string {
  switch (lens) {
    case 'correctness':
      return translate('localWorkflow.verifyLens.correctness', 'Is the mechanism real?')
    case 'reachability':
      return translate('localWorkflow.verifyLens.reachability', 'Can it actually happen?')
    case 'reproduction':
      return translate('localWorkflow.verifyLens.reproduction', 'Can it be reproduced?')
    default:
      return discoverLensLabel(lens)
  }
}

export function discoverDepthLabel(depth: DiscoverDepth): string {
  switch (depth) {
    case 'quick':
      return translate('localWorkflow.depth.quick', 'Quick')
    case 'thorough':
      return translate('localWorkflow.depth.thorough', 'Thorough')
    case 'exhaustive':
      return translate('localWorkflow.depth.exhaustive', 'Exhaustive')
  }
}

export function discoverDepthNote(depth: DiscoverDepth): string {
  switch (depth) {
    case 'quick':
      return translate('localWorkflow.depth.quickNote', 'One round of searching.')
    case 'thorough':
      return translate(
        'localWorkflow.depth.thoroughNote',
        'Up to 3 rounds; stops after a round finds nothing new.'
      )
    case 'exhaustive':
      return translate(
        'localWorkflow.depth.exhaustiveNote',
        'Up to 5 rounds; stops after two rounds find nothing new.'
      )
  }
}

export function runStateLabel(state: LocalWorkflowRunState): string {
  switch (state) {
    case 'running':
      return translate('localWorkflow.run.stateRunning', 'Working')
    case 'pausing':
      return translate('localWorkflow.run.statePausing', 'Pausing')
    case 'paused':
      return translate('localWorkflow.run.statePaused', 'Paused')
    case 'stopping':
      return translate('localWorkflow.run.stateStopping', 'Stopping')
    case 'cancelled':
      return translate('localWorkflow.run.stateStopped', 'Stopped')
    case 'completed':
      return translate('localWorkflow.run.stateDone', 'Done')
    case 'failed':
      return translate('localWorkflow.run.stateFailed', 'Failed')
    case 'recovery_required':
      return translate('localWorkflow.run.stateNeedsYou', 'Needs you')
    case 'budget_paused':
      return translate('localWorkflow.run.stateLimitReached', 'Paused at its limit')
  }
}

export function callStateLabel(call: Pick<LocalWorkflowCallView, 'state' | 'live'>): string {
  switch (call.state) {
    case 'queued':
      return call.live?.phase === 'starting'
        ? translate('localWorkflow.call.starting', 'Starting')
        : translate('localWorkflow.call.waiting', 'Waiting')
    case 'running':
      return call.live?.phase === 'finishing'
        ? translate('localWorkflow.call.finishing', 'Finishing')
        : translate('localWorkflow.call.running', 'Working')
    case 'completed':
      return translate('localWorkflow.call.done', 'Done')
    case 'failed':
      return translate('localWorkflow.call.failed', 'Failed')
    case 'cancelled':
      return translate('localWorkflow.call.stopped', 'Stopped')
    case 'unverifiable':
      return translate('localWorkflow.call.unverifiable', "Couldn't confirm")
  }
}

export function severityLabel(severity: LocalWorkflowDiscoverSeverity): string {
  switch (severity) {
    case 'critical':
      return translate('localWorkflow.severity.critical', 'Critical')
    case 'high':
      return translate('localWorkflow.severity.high', 'High')
    case 'medium':
      return translate('localWorkflow.severity.medium', 'Medium')
    case 'low':
      return translate('localWorkflow.severity.low', 'Low')
  }
}

function findingStatusLabel(status: LocalWorkflowDiscoverFinding['status']): string {
  switch (status) {
    case 'verifying':
      return translate('localWorkflow.finding.verifying', 'Verifying')
    case 'confirmed':
      return translate('localWorkflow.finding.confirmed', 'Confirmed')
    case 'refuted':
      return translate('localWorkflow.finding.refuted', 'Refuted')
    case 'unverified':
      return translate('localWorkflow.finding.unverified', 'Unverified')
  }
}

/**
 * A finding still owed its votes waits to verify until one of them has started (votes wait for the
 * round's repeat check and for free slots). Once one runs it is verifying, also between votes.
 */
export function discoverFindingAwaitsVotes(
  finding: Pick<LocalWorkflowDiscoverFinding, 'status' | 'votes'>
): boolean {
  return finding.status === 'verifying' && finding.votes.every((vote) => vote.state === 'pending')
}

/** A finding's status as the card reads it. */
export function discoverFindingStatusLabel(
  finding: Pick<LocalWorkflowDiscoverFinding, 'status' | 'votes'>
): string {
  return discoverFindingAwaitsVotes(finding)
    ? translate('localWorkflow.finding.waitingToVerify', 'Waiting to verify')
    : findingStatusLabel(finding.status)
}

/** "12s", "3:04", "1:02:03": compact elapsed time for live rows. */
export function formatWorkflowElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, '0')
  if (hours) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
  }
  return total < 60 ? `${total}s` : `${minutes}:${seconds}`
}

/** "812", "3.4k", "1.2M": the row shows scale, not a ledger. */
export function formatWorkflowTokens(tokens: number): string {
  if (tokens < 1_000) {
    return String(Math.round(tokens))
  }
  const scaled = tokens < 1_000_000 ? tokens / 1_000 : tokens / 1_000_000
  return `${scaled.toFixed(1).replace(/\.0$/, '')}${tokens < 1_000_000 ? 'k' : 'M'}`
}
