import React from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { describeBriefActor } from '../../../../../shared/assisted-brief-actors'
import { canChallengeBrief } from '../../../../../shared/assisted-brief-challenge'
import { currentBriefRevision } from '../../../../../shared/assisted-brief-revisions'
import {
  BRIEF_LIST_SECTIONS,
  type AssistedBriefRecord,
  type BriefActor,
  type BriefChallengeFinding
} from '../../../../../shared/assisted-brief-types'
import {
  briefChallengeKindLabel,
  briefChangeLabel,
  briefDecisionLabel
} from './assisted-brief-labels'

type Decision = BriefChallengeFinding['decision']

function FindingRow({
  finding,
  open,
  disabled,
  itemText,
  onDecide
}: {
  finding: BriefChallengeFinding
  open: boolean
  disabled: boolean
  itemText: (id: string) => string | undefined
  onDecide: (findingId: string, decision: Decision) => void
}): React.JSX.Element {
  const toggle = (decision: Decision): void =>
    onDecide(finding.id, finding.decision === decision ? 'pending' : decision)
  return (
    <li className="space-y-1 rounded-md border border-border px-2 py-1.5">
      <p className="text-[11px] font-medium text-muted-foreground">
        {briefChallengeKindLabel(finding.kind)}
      </p>
      <p className="text-sm">{finding.note}</p>
      <p className="text-[11px] text-muted-foreground">
        {briefChangeLabel(finding.change, itemText)}
      </p>
      {open ? (
        <div className="flex gap-1">
          {(['accepted', 'rejected'] as const).map((decision) => (
            <Button
              key={decision}
              type="button"
              size="xs"
              variant={finding.decision === decision ? 'secondary' : 'ghost'}
              aria-pressed={finding.decision === decision}
              disabled={disabled}
              onClick={() => toggle(decision)}
            >
              {decision === 'accepted'
                ? translate('assistedBrief.accept', 'Accept')
                : translate('assistedBrief.reject', 'Reject')}
            </Button>
          ))}
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">{briefDecisionLabel(finding.decision)}</p>
      )}
    </li>
  )
}

/**
 * The optional independent review: one round by a different model. Findings are suggestions
 * until the person accepts or rejects each one; applying them makes one new revision.
 */
export function AssistedBriefChallengePanel({
  record,
  reviewer,
  disabled,
  onRun,
  onDecide,
  onApply
}: {
  record: AssistedBriefRecord
  reviewer: BriefActor | null
  disabled: boolean
  onRun: () => void
  onDecide: (findingId: string, decision: Decision) => void
  onApply: () => void
}): React.JSX.Element | null {
  const challenge = record.challenge
  if (!challenge) {
    return canChallengeBrief(record) ? (
      <section className="space-y-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || !reviewer}
          onClick={onRun}
        >
          {reviewer
            ? translate('assistedBrief.challengeWith', 'Get a second opinion from {{reviewer}}', {
                reviewer: describeBriefActor(reviewer)
              })
            : translate(
                'assistedBrief.challengeUnavailable',
                'A second opinion needs a favourite on a different model'
              )}
        </Button>
        <p className="text-[11px] text-muted-foreground">
          {translate(
            'assistedBrief.challengeHelp',
            'Optional, one round. A different model looks for missed requirements, unsupported assumptions, unnecessary work and regressions. You accept or reject each finding.'
          )}
        </p>
      </section>
    ) : null
  }
  const content = currentBriefRevision(record).content
  const itemText = (id: string): string | undefined =>
    BRIEF_LIST_SECTIONS.flatMap((section) => content.sections[section]).find(
      (item) => item.id === id
    )?.text
  const open = challenge.status === 'open'
  const pending = challenge.findings.filter((finding) => finding.decision === 'pending').length
  return (
    <section className="space-y-1.5 rounded-md border border-border p-2" data-brief-challenge="">
      <h3 className="text-xs font-medium text-foreground">
        {translate('assistedBrief.challengeTitle', 'Second opinion from {{reviewer}}', {
          reviewer: describeBriefActor(challenge.reviewer)
        })}
      </h3>
      {challenge.findings.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {translate('assistedBrief.challengeNoFindings', 'The reviewer suggested no changes.')}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {challenge.findings.map((finding) => (
            <FindingRow
              key={finding.id}
              finding={finding}
              open={open}
              disabled={disabled}
              itemText={itemText}
              onDecide={onDecide}
            />
          ))}
        </ul>
      )}
      {open ? (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={disabled || pending > 0}
          onClick={onApply}
        >
          {pending > 0
            ? translate(
                'assistedBrief.decideAll',
                'Accept or reject each finding ({{count}} left)',
                {
                  count: pending
                }
              )
            : translate('assistedBrief.applyDecisions', 'Apply decisions')}
        </Button>
      ) : null}
    </section>
  )
}
