import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { SavedFolderChooser } from '@/components/next-step/SessionFinishFields'
import { cn } from '@/lib/utils'
import { sessionFinishActionFrom, type WhenFinishedValue } from './when-finished-value'

const CHOICES = ['close', 'save'] as const

function choiceLabel(finish: WhenFinishedValue['finish']): string {
  return finish === 'save'
    ? translate('nextAction.saveSession', 'Save session')
    : translate('nextAction.closeSession', 'Close session')
}

/** A session preference, independent of the ordered work above it. */
export function WhenFinished({
  value,
  onChange,
  disabled = false
}: {
  value: WhenFinishedValue
  onChange: (value: WhenFinishedValue) => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <div className="space-y-1.5" data-next-action-when-finished>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {translate('nextAction.whenFinished', 'When finished')}
        </span>
        <div
          className="inline-flex overflow-hidden rounded-md border border-border"
          role="group"
          aria-label={translate('nextAction.whenFinished', 'When finished')}
        >
          {CHOICES.map((finish) => (
            <Button
              key={finish}
              type="button"
              size="xs"
              variant={value.finish === finish ? 'secondary' : 'ghost'}
              aria-pressed={value.finish === finish}
              disabled={disabled}
              className={cn('h-7 rounded-none px-3 text-xs')}
              onClick={() =>
                onChange(
                  finish === value.finish
                    ? { finish: 'none' }
                    : finish === 'save'
                      ? {
                          finish: 'save',
                          ...(value.folderId ? { folderId: value.folderId } : {})
                        }
                      : { finish: 'close' }
                )
              }
            >
              {choiceLabel(finish)}
            </Button>
          ))}
        </div>
      </div>
      <p className="text-[12px] text-muted-foreground" data-next-action-when-finished-hint>
        {value.finish === 'none'
          ? translate(
              'nextAction.finishDefaultHint',
              'No selection: the finished session stays in Done.'
            )
          : translate(
              'nextAction.finishAfterWorkHint',
              'Applies after the session and all queued work finish. Click again to clear.'
            )}
      </p>
      {value.finish === 'save' ? (
        <fieldset disabled={disabled}>
          <SavedFolderChooser
            value={sessionFinishActionFrom(value)}
            onChange={(action) =>
              onChange({
                finish: 'save',
                ...(action.folderId ? { folderId: action.folderId } : {})
              })
            }
          />
        </fieldset>
      ) : null}
    </div>
  )
}
