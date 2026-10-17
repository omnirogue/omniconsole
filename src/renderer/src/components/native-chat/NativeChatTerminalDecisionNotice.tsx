import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

export function NativeChatTerminalDecisionNotice({
  onSwitchToTerminal
}: {
  onSwitchToTerminal?: () => void
}): React.JSX.Element {
  return (
    <div
      role="status"
      className="mx-4 mb-2 flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
    >
      <span className="min-w-0 flex-1">
        {translate(
          'conversations.terminalDecisionRequired',
          'The agent is waiting for your decision. Review it in Terminal.'
        )}
      </span>
      {onSwitchToTerminal && (
        <Button variant="outline" size="xs" onClick={onSwitchToTerminal}>
          {translate('conversations.stopOpenTerminal', 'Open Terminal')}
        </Button>
      )}
    </div>
  )
}
