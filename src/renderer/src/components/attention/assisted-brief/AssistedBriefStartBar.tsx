import React from 'react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import { currentBriefRevision } from '../../../../../shared/assisted-brief-revisions'
import { currentRevisionStart } from '../../../../../shared/assisted-brief-start'
import type {
  AssistedBriefRecord,
  BriefStartRecord
} from '../../../../../shared/assisted-brief-types'
import type { AttentionLaunchPlan } from '../../../../../shared/attention-launch-favorites'
import { briefStartFailureLabel } from './assisted-brief-labels'

function lastEarlierStart(record: AssistedBriefRecord, revision: number): BriefStartRecord | null {
  let found: BriefStartRecord | null = null
  for (const entry of record.starts) {
    if (entry.status === 'started' && entry.revision !== revision) {
      found = entry
    }
  }
  return found
}

function StartStatus({
  record,
  sessionsReady,
  onRelease
}: {
  record: AssistedBriefRecord
  sessionsReady: boolean
  onRelease: (operationId: string) => void
}): React.JSX.Element {
  const revision = currentBriefRevision(record).number
  const start = currentRevisionStart(record)
  const previous = lastEarlierStart(record, revision)
  const muted = 'text-[11px] text-muted-foreground'
  if (start?.status === 'started') {
    return (
      <p className={muted} role="status">
        {translate(
          'assistedBrief.started',
          'Started revision {{revision}}. The session is under Working on.',
          { revision }
        )}
      </p>
    )
  }
  if (start?.status === 'starting') {
    return (
      <p className={muted} role="status">
        {translate(
          'assistedBrief.checkingStart',
          'Checking whether revision {{revision}} already started.',
          { revision }
        )}
      </p>
    )
  }
  if (start?.status === 'unconfirmed') {
    return (
      <div className="space-y-1" role="status">
        <p className="text-[11px] text-foreground">
          {translate(
            'assistedBrief.unconfirmed',
            'This start could not be confirmed. Check Working on before starting again.'
          )}
        </p>
        <Button
          type="button"
          variant="link"
          size="xs"
          className="h-auto p-0 text-[11px]"
          onClick={() => onRelease(start.operationId)}
        >
          {translate('assistedBrief.didNotStart', 'It did not start; allow Start again')}
        </Button>
      </div>
    )
  }
  if (start?.status === 'not-started') {
    return <p className={muted}>{briefStartFailureLabel(start.failure)}</p>
  }
  if (!sessionsReady) {
    return (
      <p className={muted}>
        {translate(
          'assistedBrief.restoringSessions',
          'Restoring saved sessions before anything can start.'
        )}
      </p>
    )
  }
  if (previous) {
    return (
      <p className={muted}>
        {translate(
          'assistedBrief.previousStarted',
          'Revision {{revision}} already started. Starting this revision opens a new session.',
          { revision: previous.revision }
        )}
      </p>
    )
  }
  return (
    <p className={muted}>
      {translate(
        'assistedBrief.startHelp',
        "Start approves and sends this exact revision once. The session is asked to run routine steps without checking back; tool approvals follow the favourite's settings."
      )}
    </p>
  )
}

/** Who starts the work, the single Start action, and the honest state of this revision's start. */
export function AssistedBriefStartBar({
  record,
  plans,
  selectedId,
  disabled,
  sessionsReady,
  onSelect,
  onStart,
  onRelease
}: {
  record: AssistedBriefRecord
  plans: readonly AttentionLaunchPlan[]
  selectedId: string
  disabled: boolean
  sessionsReady: boolean
  onSelect: (favoriteId: string) => void
  onStart: () => void
  onRelease: (operationId: string) => void
}): React.JSX.Element {
  const plan = plans.find((entry) => entry.favorite.id === selectedId) ?? plans[0]
  const status = currentRevisionStart(record)?.status
  const locked = status === 'starting' || status === 'started' || status === 'unconfirmed'
  return (
    <section className="space-y-1.5" data-brief-start="">
      <div className="flex flex-wrap items-center gap-1.5">
        <Select value={plan?.favorite.id ?? ''} onValueChange={onSelect} disabled={disabled}>
          <SelectTrigger
            className="h-8 w-56 text-xs"
            aria-label={translate('assistedBrief.startWith', 'Who starts the work')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {plans.map((entry) => (
              <SelectItem
                key={entry.favorite.id}
                value={entry.favorite.id}
                disabled={entry.blockers.length > 0}
              >
                {entry.favorite.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          size="sm"
          data-brief-start-button=""
          disabled={disabled || locked || !sessionsReady || !plan || plan.blockers.length > 0}
          onClick={onStart}
        >
          {translate('assistedBrief.start', 'Start')}
        </Button>
      </div>
      <StartStatus record={record} sessionsReady={sessionsReady} onRelease={onRelease} />
    </section>
  )
}
