import { useState } from 'react'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { SessionChain } from '../../../../shared/session-chain-types'
import {
  commitOutcomeEdit,
  isOutcomeRevisionConflict,
  outcomeEditFrom,
  type OutcomeEdit,
  type OutcomeEditDoor
} from './outcome-edit'

/** Revision-checked editing of the outcome, conditions and prompts that have not started. */
export function OutcomeInlineEditor({
  chain,
  door,
  onChainChanged,
  onClose
}: {
  chain: SessionChain
  door: OutcomeEditDoor
  onChainChanged: (chain: SessionChain) => void
  onClose: () => void
}): React.JSX.Element {
  const [edit, setEdit] = useState<OutcomeEdit>(() => outcomeEditFrom(chain))
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async (): Promise<void> => {
    setPending(true)
    setError(null)
    try {
      const next = await commitOutcomeEdit({ chain, edit, door })
      onChainChanged(next)
      onClose()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message)
      if (isOutcomeRevisionConflict(message)) {
        try {
          const fresh = await door.reload(chain)
          onChainChanged(fresh)
          setEdit(outcomeEditFrom(fresh))
        } catch (reloadFailure) {
          setError(reloadFailure instanceof Error ? reloadFailure.message : String(reloadFailure))
        }
      }
    } finally {
      setPending(false)
    }
  }
  return (
    <div
      className="space-y-2"
      data-next-action-outcome-editor
      // Escape closes the editor and stops there: the popover hosting the composer must not
      // fold on the same press.
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onClose()
        }
      }}
    >
      <Textarea
        rows={2}
        className="text-sm"
        value={edit.sentence}
        aria-label={translate('nextAction.outcomeSentence', 'Outcome sentence')}
        onChange={(event) => setEdit({ ...edit, sentence: event.target.value })}
      />
      {edit.actions.map((action, index) => (
        <label key={action.key} className="block space-y-1 text-xs">
          <span className="font-medium">
            {translate('nextAction.actionPrompt', 'Next action {{n}}', { n: index + 1 })}
            {' · '}
            {action.title}
          </span>
          <Textarea
            rows={6}
            className="text-sm"
            aria-label={translate('nextAction.actionPrompt', 'Next action {{n}}', { n: index + 1 })}
            value={action.instruction}
            readOnly={action.readOnly}
            disabled={pending}
            onChange={(event) =>
              setEdit({
                ...edit,
                actions: edit.actions.map((entry) =>
                  entry.key === action.key ? { ...entry, instruction: event.target.value } : entry
                )
              })
            }
          />
          {action.readOnly ? (
            <span className="text-muted-foreground">
              {translate(
                'nextAction.actionAlreadyStarted',
                'This action has already started and cannot be rewritten.'
              )}
            </span>
          ) : null}
        </label>
      ))}
      {edit.conditions.length > 0 ? (
        <div className="space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {translate('nextAction.doneWhen', 'Done when')}
          </p>
          {edit.conditions.map((condition, index) => (
            <Input
              key={condition.key}
              className="h-7 text-xs"
              value={condition.label}
              aria-label={translate('nextAction.doneWhenCondition', 'Done when condition {{n}}', {
                n: index + 1
              })}
              onChange={(event) =>
                setEdit({
                  ...edit,
                  conditions: edit.conditions.map((entry) =>
                    entry.key === condition.key ? { ...entry, label: event.target.value } : entry
                  )
                })
              }
            />
          ))}
        </div>
      ) : null}
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <Button type="button" size="xs" disabled={pending} onClick={() => void save()}>
          {translate('nextAction.saveOutcome', 'Save')}
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={onClose}>
          {translate('nextAction.cancelOutcome', 'Cancel')}
        </Button>
      </div>
    </div>
  )
}
