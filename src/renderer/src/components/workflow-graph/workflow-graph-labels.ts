import { translate } from '@/i18n/i18n'
import type {
  LocalWorkflowEvidenceStatus,
  LocalWorkflowGraphState,
  LocalWorkflowGraphVerdict
} from '../../../../shared/local-workflow-view'
import type { WorkflowStepKind } from '../../../../shared/workflow-graph'

/** Labels are functions: translate() may not run at module load. */
export function workflowKindLabel(kind: WorkflowStepKind): string {
  switch (kind) {
    case 'do':
      return translate('workflowGraph.kind.do', 'Do')
    case 'review':
      return translate('workflowGraph.kind.review', 'Review')
    case 'rank':
      return translate('workflowGraph.kind.rank', 'Rank')
    case 'synthesize':
      return translate('workflowGraph.kind.synthesize', 'Synthesize')
  }
}

export function workflowKindHint(kind: WorkflowStepKind): string {
  switch (kind) {
    case 'do':
      return translate(
        'workflowGraph.kindHint.do',
        'Agents do the work: answer, research, draft or find.'
      )
    case 'review':
      return translate(
        'workflowGraph.kindHint.review',
        'Agents critique their inputs and end with a verdict: pass, fail or unsure.'
      )
    case 'rank':
      return translate(
        'workflowGraph.kindHint.rank',
        'Agents compare the answers blind and rank them; a model never counts its own.'
      )
    case 'synthesize':
      return translate(
        'workflowGraph.kindHint.synthesize',
        'One agent writes the single final answer from everything it receives.'
      )
  }
}

export function workflowStateLabel(state: LocalWorkflowGraphState): string {
  switch (state) {
    case 'waiting':
      return translate('workflowGraph.state.waiting', 'Waiting')
    case 'running':
      return translate('workflowGraph.state.running', 'Running')
    case 'done':
      return translate('workflowGraph.state.done', 'Done')
    case 'gaps':
      return translate('workflowGraph.state.gaps', 'Done with gaps')
    case 'failed':
      return translate('workflowGraph.state.failed', 'Failed')
    case 'not-run':
      return translate('workflowGraph.state.notRun', 'Not run')
    case 'empty':
      return translate('workflowGraph.state.empty', 'Nothing to do')
  }
}

export const WORKFLOW_STATE_DOT: Record<LocalWorkflowGraphState, string> = {
  waiting: 'border border-muted-foreground/50 bg-transparent',
  running: 'bg-status-info motion-safe:animate-pulse',
  done: 'bg-status-success',
  gaps: 'bg-status-warning',
  failed: 'bg-destructive',
  'not-run': 'bg-muted-foreground/40',
  empty: 'bg-muted-foreground/40'
}

export function workflowVerdictLabel(verdict: LocalWorkflowGraphVerdict | null): string {
  switch (verdict) {
    case 'pass':
      return translate('workflowGraph.verdict.pass', 'Pass')
    case 'fail':
      return translate('workflowGraph.verdict.fail', 'Fail')
    case 'unsure':
      return translate('workflowGraph.verdict.unsure', 'Unsure')
    case null:
      return translate('workflowGraph.verdict.none', 'No answer')
  }
}

export function workflowTallyLabel(tally: 'confirmed' | 'refuted' | 'unverified'): string {
  switch (tally) {
    case 'confirmed':
      return translate('workflowGraph.tally.confirmed', 'Confirmed')
    case 'refuted':
      return translate('workflowGraph.tally.refuted', 'Refuted')
    case 'unverified':
      return translate('workflowGraph.tally.unverified', 'Unverified')
  }
}

/**
 * A result's verdict in words: live JEV verify's set-aside is named as JEV's, with its p, and a
 * set-aside a later report reopened says so rather than a bare Unverified.
 */
export function workflowTargetTallyLabel(target: {
  tally: 'confirmed' | 'refuted' | 'unverified'
  refutedBy?: 'jev'
  jevVerify?: number
  resurfaced?: true
  setAsideAt?: number
}): string {
  if (target.tally === 'unverified' && target.resurfaced) {
    return target.setAsideAt === undefined
      ? translate(
          'workflowGraph.tally.resurfaced',
          'Unverified: reported again after JEV set it aside'
        )
      : translate(
          'workflowGraph.tally.resurfacedAt',
          'Unverified: reported again after JEV set it aside (p {{p}})',
          { p: target.setAsideAt.toFixed(2) }
        )
  }
  return target.tally === 'refuted' && target.refutedBy === 'jev'
    ? translate('workflowGraph.tally.jevSetAside', 'Set aside by JEV (p {{p}})', {
        p: target.jevVerify?.toFixed(2) ?? '?'
      })
    : workflowTallyLabel(target.tally)
}

/** The app's quote check in plain words; nothing for a result that quotes no code. */
export function workflowEvidenceLabel(
  status: LocalWorkflowEvidenceStatus | undefined
): string | undefined {
  switch (status) {
    case 'found':
      return translate('resultsLaunch.quoteFound', 'quote checked in the file')
    case 'moved':
      return translate('resultsLaunch.quoteMoved', 'quote found elsewhere in the file')
    case 'missing':
      return translate('resultsLaunch.quoteMissing', 'quote not found in the file')
    case 'unreadable':
      return translate('resultsLaunch.quoteUnreadable', 'file could not be read')
    case 'not-code':
    case 'unquoted':
    case undefined:
      return undefined
  }
}
