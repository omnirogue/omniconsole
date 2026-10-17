import { translate } from '@/i18n/i18n'
import {
  ASSISTED_BRIEF_LIMITS,
  type BriefChallengeChange,
  type BriefChallengeFinding,
  type BriefChallengeKind,
  type BriefItemOrigin,
  type BriefListSection,
  type BriefRevisionCause,
  type BriefStartFailure
} from '../../../../../shared/assisted-brief-types'

export function briefSectionLabel(section: BriefListSection): string {
  switch (section) {
    case 'scope':
      return translate('assistedBrief.sectionScope', 'Scope')
    case 'constraints':
      return translate('assistedBrief.sectionConstraints', 'Constraints')
    case 'assumptions':
      return translate('assistedBrief.sectionAssumptions', 'Assumptions')
    case 'deliverables':
      return translate('assistedBrief.sectionDeliverables', 'Deliverables')
    case 'successChecks':
      return translate('assistedBrief.sectionSuccessChecks', 'How success is checked')
  }
}

export function briefSectionFullLabel(section: BriefListSection): string {
  return translate(
    'assistedBrief.sectionFull',
    '{{section}} already has {{max}} lines. Remove one first.',
    { section: briefSectionLabel(section), max: ASSISTED_BRIEF_LIMITS.itemsPerSection }
  )
}

export function briefProposalLabel(origin: BriefItemOrigin): string {
  if (origin === 'ai-assumption') {
    return translate('assistedBrief.originAssumption', 'AI assumption')
  }
  if (origin === 'challenge') {
    return translate('assistedBrief.originReviewer', 'Reviewer suggestion')
  }
  return translate('assistedBrief.originSuggestion', 'AI suggestion')
}

export function briefRevisionCauseLabel(cause: BriefRevisionCause): string {
  switch (cause) {
    case 'drafted':
      return translate('assistedBrief.causeDrafted', 'drafted')
    case 'edited':
      return translate('assistedBrief.causeEdited', 'edited')
    case 'added':
      return translate('assistedBrief.causeAdded', 'line added')
    case 'answered':
      return translate('assistedBrief.causeAnswered', 'answers added')
    case 'removed':
      return translate('assistedBrief.causeRemoved', 'line removed')
    case 'challenge-applied':
      return translate('assistedBrief.causeChallenge', 'second opinion applied')
    case 'workspace-changed':
      return translate('assistedBrief.causeWorkspace', 'workspace changed')
  }
}

export function briefChallengeKindLabel(kind: BriefChallengeKind): string {
  switch (kind) {
    case 'missed-requirement':
      return translate('assistedBrief.kindMissed', 'Missed requirement')
    case 'unsupported-assumption':
      return translate('assistedBrief.kindUnsupported', 'Unsupported assumption')
    case 'unnecessary-work':
      return translate('assistedBrief.kindUnnecessary', 'Unnecessary work')
    case 'regression-risk':
      return translate('assistedBrief.kindRegression', 'Regression risk')
  }
}

export function briefChangeLabel(
  change: BriefChallengeChange,
  itemText: (id: string) => string | undefined
): string {
  if (change.action === 'add') {
    return translate('assistedBrief.changeAdd', 'Adds to {{section}}: {{text}}', {
      section: briefSectionLabel(change.section),
      text: change.text
    })
  }
  if (change.action === 'remove') {
    return translate('assistedBrief.changeRemove', 'Removes: {{text}}', {
      text:
        itemText(change.targetItemId) ??
        translate('assistedBrief.lineGone', 'a line that is no longer in the brief')
    })
  }
  return translate('assistedBrief.changeNone', 'No change proposed')
}

export function briefDecisionLabel(decision: BriefChallengeFinding['decision']): string {
  if (decision === 'accepted') {
    return translate('assistedBrief.decisionAccepted', 'Accepted')
  }
  if (decision === 'rejected') {
    return translate('assistedBrief.decisionRejected', 'Rejected')
  }
  return translate('assistedBrief.decisionPending', 'Not decided')
}

export type BriefStartRefusal =
  | 'no-brief'
  | 'save-failed'
  | 'in-flight'
  | 'already-started'
  | 'needs-confirmation'
  | 'sessions-restoring'
  | 'workspace-changed'

export function briefStartRefusalLabel(reason: BriefStartRefusal): string {
  switch (reason) {
    case 'no-brief':
      return translate('assistedBrief.refusedNoBrief', 'The saved brief is gone. Draft it again.')
    case 'save-failed':
      return translate(
        'assistedBrief.refusedSave',
        'The start could not be saved first, so nothing started.'
      )
    case 'in-flight':
      return translate('assistedBrief.refusedInFlight', 'This revision is already starting.')
    case 'already-started':
      return translate('assistedBrief.refusedStarted', 'This revision already started.')
    case 'needs-confirmation':
      return translate(
        'assistedBrief.refusedConfirm',
        'Confirm whether the earlier start ran before starting again.'
      )
    case 'sessions-restoring':
      return translate(
        'assistedBrief.refusedRestoring',
        'Saved sessions are still being restored. Try again in a moment.'
      )
    case 'workspace-changed':
      return translate(
        'assistedBrief.refusedWorkspace',
        'The workspace changed. Review the brief for this workspace before starting.'
      )
  }
}

export function briefStartFailureLabel(failure: BriefStartFailure | undefined): string {
  switch (failure) {
    case 'blocked':
      return translate(
        'assistedBrief.failureBlocked',
        'That favourite cannot start here right now.'
      )
    case 'repeat':
      return translate(
        'assistedBrief.failureRepeat',
        'It was launched a moment ago. Wait, then try again.'
      )
    case 'released':
      return translate(
        'assistedBrief.failureReleased',
        'You confirmed the earlier start did not run.'
      )
    case 'launch-failed':
    case undefined:
      return translate('assistedBrief.failureLaunch', 'The launch command could not be built.')
  }
}
