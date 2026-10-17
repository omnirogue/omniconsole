import { useId, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { ChevronLeft, ChevronRight, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import type { NextStepOutcomeDraft } from '../../../../shared/next-step-draft'
import { outcomeFinishLabel } from './next-step-summary'

/**
 * Only a chain saved with several outcomes shows this: which one the sections edit, and the
 * one place a committed outcome can leave scope — with a reason, never silently.
 */
export function NextStepOutcomeSwitcher({
  outcomes,
  index,
  onIndexChange,
  onRemove
}: {
  outcomes: readonly NextStepOutcomeDraft[]
  index: number
  onIndexChange: (index: number) => void
  onRemove: (index: number, reason?: string) => void
}): React.JSX.Element {
  const id = useId()
  const [removing, setRemoving] = useState(false)
  const [reason, setReason] = useState('')
  const outcome = outcomes[index]!
  const number = index + 1
  return (
    <div
      className="space-y-2 rounded-md border border-border/60 bg-muted/20 p-2"
      data-next-step-outcome-switcher
    >
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={translate('nextStep.previousOutcome', 'Previous outcome')}
          disabled={index === 0}
          onClick={() => onIndexChange(index - 1)}
        >
          <ChevronLeft className="size-3.5" />
        </Button>
        <p
          className="min-w-0 flex-1 truncate text-xs font-medium"
          title={outcomeFinishLabel(outcome.finish)}
        >
          {translate('nextStep.outcomeOf', 'Outcome {{number}} of {{count}}', {
            number,
            count: outcomes.length
          })}
          {` → ${outcomeFinishLabel(outcome.finish)}`}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={translate('nextStep.nextOutcome', 'Next outcome')}
          disabled={index >= outcomes.length - 1}
          onClick={() => onIndexChange(index + 1)}
        >
          <ChevronRight className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={translate('nextStep.removeOutcome', 'Remove outcome {{number}}', { number })}
          onClick={() => (outcome.revision === undefined ? onRemove(index) : setRemoving(true))}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
      {removing ? (
        <div className="space-y-2 rounded-md border border-destructive/40 p-2">
          <Label htmlFor={`${id}-removal`} className="text-xs">
            {translate('nextStep.outcomeLeavingScope', 'Why is this outcome leaving scope?')}
          </Label>
          <Textarea
            id={`${id}-removal`}
            rows={2}
            value={reason}
            aria-label={translate(
              'nextStep.removalReason',
              'Removal reason for outcome {{number}}',
              {
                number
              }
            )}
            onChange={(event) => setReason(event.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="xs" onClick={() => setRemoving(false)}>
              {translate('nextStep.keepOutcome', 'Keep outcome')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="xs"
              disabled={!reason.trim()}
              onClick={() => {
                setRemoving(false)
                onRemove(index, reason.trim())
              }}
            >
              {translate('nextStep.confirmScopeChange', 'Confirm scope change')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
