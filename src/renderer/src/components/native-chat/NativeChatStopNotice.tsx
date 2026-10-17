import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

export function NativeChatStopNotice({
  pending,
  unverified,
  backgroundStopRequested = false,
  onSwitchToTerminal
}: {
  pending: boolean
  unverified: boolean
  backgroundStopRequested?: boolean
  onSwitchToTerminal?: () => void
}): React.JSX.Element | null {
  if (!pending && !unverified && !backgroundStopRequested) {
    return null
  }
  return (
    <div
      role={unverified ? 'alert' : 'status'}
      data-native-chat-stop={pending ? 'pending' : unverified ? 'unverified' : 'requested'}
      className="mx-4 mb-2 flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
    >
      <span className="min-w-0 flex-1">
        {pending
          ? translate('conversations.stopPending', 'Stopping the current turn…')
          : unverified
            ? translate(
                'conversations.stopUnverified',
                'Could not confirm Stop. Check Terminal for running tools.'
              )
            : translate('conversations.stopRequested', 'Stop requested for background tools.')}
      </span>
      {unverified && onSwitchToTerminal && (
        <Button variant="outline" size="xs" onClick={onSwitchToTerminal}>
          {translate('conversations.stopOpenTerminal', 'Open Terminal')}
        </Button>
      )}
    </div>
  )
}
