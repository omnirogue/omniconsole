import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { OutcomeCapabilities } from './next-step-outcome-client'
import type { NextStepPrimaryAction } from './next-step-outcome-primary-action'

/** The primary button says what will happen; nothing else in the footer competes with it. */
export function primaryActionLabel(action: NextStepPrimaryAction): string {
  switch (action.kind) {
    case 'save':
      return translate('nextStep.saveAndHide', 'Save & hide')
    case 'start':
      return action.count === 1
        ? translate('nextStep.startOneStep', 'Start 1 step')
        : translate('nextStep.startSteps', 'Start {{count}} steps', { count: action.count })
    case 'send':
      return translate('nextStep.sendTo', 'Send to {{name}}', { name: action.name })
    case 'handoff':
      return translate('nextStep.handOffTo', 'Hand off to {{name}}', { name: action.name })
    case 'choose-teammate':
      return translate('nextStep.chooseTeammate', 'Choose a teammate')
  }
}

export function NextStepOutcomeFooter({
  pending,
  timing,
  capabilities,
  hasAgent,
  action,
  onHide,
  onSave
}: {
  pending: boolean
  timing: 'now' | 'done'
  capabilities: OutcomeCapabilities | null
  hasAgent: boolean
  action: NextStepPrimaryAction
  onHide: () => void
  onSave: () => void
}): React.JSX.Element {
  const hostBlocked = timing === 'done' && (!capabilities?.durableContinuation || !hasAgent)
  return (
    <div className="sticky bottom-0 flex items-center justify-between gap-3 border-t border-border/60 bg-background/95 p-3 backdrop-blur">
      <Button type="button" variant="ghost" size="sm" onClick={onHide}>
        {translate('nextStep.hide', 'Hide')}
      </Button>
      <div className="text-right">
        <Button
          type="button"
          disabled={pending || action.kind === 'choose-teammate' || hostBlocked}
          onClick={onSave}
        >
          {pending ? translate('nextStep.saving', 'Saving…') : primaryActionLabel(action)}
        </Button>
        {!pending && timing === 'done' && !capabilities?.durableContinuation ? (
          <p className="mt-1 text-xs text-muted-foreground" aria-live="polite">
            {capabilities?.reason ??
              translate(
                'nextStep.checkingOutcomeHost',
                'Checking whether this execution host can continue outcomes…'
              )}
          </p>
        ) : null}
      </div>
    </div>
  )
}
