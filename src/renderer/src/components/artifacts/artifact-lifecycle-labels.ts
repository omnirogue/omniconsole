import type { ArtifactLastDecision, ArtifactListItem } from '../../../../shared/artifacts'
import type { ArtifactReviewDecision } from '../../../../shared/artifact-review'
import { getIntlLocale, translate } from '@/i18n/i18n'
import { artifactTypeLabel, formatArtifactExpiry, formatByteSize } from './artifact-display-labels'
import {
  capitalizeAgentName,
  shortSessionRef,
  type ArtifactRowStatus
} from './artifact-lifecycle-model'

export function artifactDecisionLabel(decision: ArtifactLastDecision['decision']): string {
  switch (decision) {
    case 'approved':
      return translate('auto.components.artifacts.lifecycle.approved', 'Approved')
    case 'changes_requested':
      return translate('auto.components.artifacts.lifecycle.changesRequested', 'Changes requested')
    case 'rejected':
      return translate('auto.components.artifacts.lifecycle.rejected', 'Rejected')
  }
  // Why: a newer server may send a decision this build has no words for; show it as sent.
  return String(decision).replace(/_/g, ' ')
}

/** Chip words for the Status column; the successor title is resolved by the caller. */
export function artifactStatusText(status: ArtifactRowStatus, successorTitle: string): string {
  switch (status.kind) {
    case 'superseded':
      return translate('auto.components.artifacts.lifecycle.superseded', 'Superseded → {{title}}', {
        title: successorTitle
      })
    case 'done':
      return translate('auto.components.artifacts.lifecycle.done', 'Done')
    case 'no_action':
      return translate('auto.components.artifacts.lifecycle.noAction', 'No action')
    case 'decided':
      return translate(
        'auto.components.artifacts.lifecycle.decided',
        'Decided · {{decision}} · rev {{revision}}',
        {
          decision: artifactDecisionLabel(status.decision),
          revision: status.revision
        }
      )
    case 'needs_you':
      return status.decidedAtRevision === null
        ? translate('auto.components.artifacts.lifecycle.needsYou', 'Needs you')
        : translate(
            'auto.components.artifacts.lifecycle.needsYouDecidedAt',
            'Needs you · decided at rev {{revision}}',
            {
              revision: status.decidedAtRevision
            }
          )
    case 'pending':
      return translate('auto.components.artifacts.lifecycle.pending', 'Pending')
    case 'none':
      return ''
  }
}

export function artifactSuccessorFallbackTitle(): string {
  return translate('auto.components.artifacts.lifecycle.anotherPage', 'another page')
}

/** Words for `review.context.kind`; null for a kind this desktop has no words for. */
export function artifactKindLabel(kind: string | undefined): string | null {
  if (kind === undefined) {
    return null
  }
  return artifactKindLabelFor(kind)
}

function artifactKindLabelFor(kind: string): string | null {
  switch (kind) {
    case 'decision':
      return translate('auto.components.artifacts.kind.decision', 'Decision')
    case 'approval':
      return translate('auto.components.artifacts.kind.approval', 'Approval')
    case 'review':
      return translate('auto.components.artifacts.kind.review', 'Review')
    case 'study':
      return translate('auto.components.artifacts.kind.study', 'Study')
    case 'plan':
      return translate('auto.components.artifacts.kind.plan', 'Plan')
    case 'customer_send':
      return translate('auto.components.artifacts.kind.customerSend', 'Customer send')
    case 'ad_launch':
      return translate('auto.components.artifacts.kind.adLaunch', 'Ad launch')
    case 'budget':
      return translate('auto.components.artifacts.kind.budget', 'Budget')
    case 'deployment':
      return translate('auto.components.artifacts.kind.deployment', 'Deployment')
    case 'other':
      return translate('auto.components.artifacts.kind.other', 'Other')
    case 'presentation':
    case 'presentation_only':
      return translate('auto.components.artifacts.kind.presentation', 'Presentation')
    case 'lander_draft':
      return translate('auto.components.artifacts.kind.landerDraft', 'Lander draft')
    default:
      return null
  }
}

/** Audience words; null when an older server does not report the audience. */
export function artifactAudienceLabel(audience: string | undefined): string | null {
  if (audience === undefined) {
    return null
  }
  return artifactAudienceLabelFor(audience)
}

function artifactAudienceLabelFor(audience: string): string | null {
  switch (audience) {
    case 'public':
      return translate('auto.components.artifacts.audience.public', 'Anyone with the link')
    case 'team':
      return translate('auto.components.artifacts.audience.team', 'Signed-in team')
    case 'reviewers':
      return translate('auto.components.artifacts.audience.reviewers', 'Named reviewers')
    default:
      return null
  }
}

export function artifactReviewersLabel(item: ArtifactListItem): string | null {
  const reviewers = item.artifact.review?.reviewers ?? []
  return reviewers.length > 0
    ? translate('auto.components.artifacts.lifecycle.reviewers', 'Reviewers: {{names}}', {
        names: reviewers.join(', ')
      })
    : null
}

/** "Claude · Fix the login bug", or "Claude · session …a3f2" for a session this desktop cannot name. */
export function artifactWhoLabel(item: ArtifactListItem, sessionTitle: string | null): string {
  const agent = capitalizeAgentName(item.sessionAgent ?? '')
  const session =
    sessionTitle ||
    (item.sessionRef
      ? translate('auto.components.artifacts.lifecycle.sessionRef', 'session {{ref}}', {
          ref: shortSessionRef(item.sessionRef)
        })
      : '')
  return [agent, session].filter(Boolean).join(' · ')
}

/** Row hover: type · size · expires · audience · reviewers (the columns the table no longer shows). */
export function artifactHoverDetails(item: ArtifactListItem): string {
  return [
    artifactTypeLabel(item),
    formatByteSize(item.artifact.byteSize),
    formatArtifactExpiry(item.artifact.expiresAt),
    artifactAudienceLabel(item.artifact.audience),
    artifactReviewersLabel(item)
  ]
    .filter(Boolean)
    .join(' · ')
}

function decisionDate(at: string): string | null {
  const date = new Date(at)
  return Number.isNaN(date.getTime())
    ? null
    : new Intl.DateTimeFormat(getIntlLocale(), { day: 'numeric', month: 'short' }).format(date)
}

/** "Decisions: approved rev 5 (Sal, 27 Sep) · changes requested rev 6 (Sal, 28 Sep)", oldest first. */
export function artifactDecisionsSummary(
  decisions: readonly Pick<ArtifactReviewDecision, 'revision' | 'decision' | 'at' | 'by'>[]
): string | null {
  if (decisions.length === 0) {
    return null
  }
  const ordered = [...decisions].sort(
    (left, right) => left.revision - right.revision || left.at.localeCompare(right.at)
  )
  const parts = ordered.slice(-4).map((decision) => {
    const who = [decision.by?.name || decision.by?.email, decisionDate(decision.at)]
      .filter(Boolean)
      .join(', ')
    const words = translate(
      'auto.components.artifacts.lifecycle.decisionAtRevision',
      '{{decision}} rev {{revision}}',
      {
        decision: artifactDecisionLabel(decision.decision).toLocaleLowerCase(getIntlLocale()),
        revision: decision.revision
      }
    )
    return who ? `${words} (${who})` : words
  })
  return translate('auto.components.artifacts.lifecycle.decisions', 'Decisions: {{list}}', {
    list: parts.join(' · ')
  })
}
