import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { NextStepDraft } from '../../../../../shared/next-step-draft'
import type { TuiAgent } from '../../../../../shared/tui-agent'

/** "Just run it": one continue step for the agent that can run it, sent the ordinary way. */
export function DispatchCurrent({
  agent,
  pending,
  checking = false,
  onRun
}: {
  agent: { id: TuiAgent; label: string } | null
  pending: boolean
  /** The place's agent list is still loading: that is a wait, not "nobody can run this". */
  checking?: boolean
  onRun: (end: NextStepDraft['end']) => void
}) {
  return (
    <div className="space-y-1 border-t pt-2">
      <Button size="xs" variant="ghost" disabled={pending || !agent} onClick={() => onRun('done')}>
        {translate('nextStep.justRunEndSession', '✓ Just run it · end session')}
      </Button>
      <Button size="xs" variant="ghost" disabled={pending || !agent} onClick={() => onRun('me')}>
        {translate('nextStep.justRunMe', '↩ Just run it · back to me')}
      </Button>
      {checking ? (
        <p role="status" className="text-xs text-muted-foreground">
          {translate('nextStep.checkingFleet', 'Checking the fleet…')}
        </p>
      ) : agent ? (
        <p className="text-xs text-muted-foreground">
          {translate('nextStep.justRunAgent', 'Continues with {{agent}}.', { agent: agent.label })}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {translate('nextStep.chooseDispatchAgent', 'Choose an agent to continue this session.')}
        </p>
      )}
    </div>
  )
}
