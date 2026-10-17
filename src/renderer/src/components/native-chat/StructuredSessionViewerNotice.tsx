import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { useStructuredAgentSessionHold } from './use-structured-agent-session-hold'

export function StructuredSessionViewerNotice(props: {
  hold: ReturnType<typeof useStructuredAgentSessionHold>
}): React.JSX.Element | null {
  const { hold } = props
  const [resuming, setResuming] = useState(false)
  if (hold.processState === 'live' && !hold.fallback) {
    return null
  }
  return (
    <div
      role="status"
      className="flex items-center justify-between gap-3 border-b px-4 py-2 text-xs text-muted-foreground"
    >
      <span>
        {hold.fallback
          ? translate(
              'commandCenter.chat.legacyHost',
              'This host uses legacy viewing; opening this pane may resume the agent. Update the host for passive viewing.'
            )
          : hold.processState === 'exited'
            ? translate(
                'commandCenter.chat.paused',
                'Paused. Resume to continue this conversation.'
              )
            : hold.processState === 'checking'
              ? translate('commandCenter.chat.checking', 'Checking the session host…')
              : translate(
                  'commandCenter.chat.unverifiable',
                  'Live execution cannot be verified. The host may be unreachable.'
                )}
        {hold.error ? <span className="block text-destructive">{hold.error}</span> : null}
      </span>
      {!hold.fallback && hold.processState === 'exited' ? (
        <Button
          size="xs"
          variant="outline"
          disabled={resuming}
          onClick={() => {
            setResuming(true)
            void hold.resume().finally(() => setResuming(false))
          }}
        >
          {resuming
            ? translate('commandCenter.chat.resuming', 'Resuming…')
            : translate('commandCenter.chat.resume', 'Resume')}
        </Button>
      ) : !hold.fallback && hold.processState === 'unverifiable' ? (
        <Button size="xs" variant="outline" onClick={hold.refresh}>
          {translate('commandCenter.chat.retry', 'Retry connection')}
        </Button>
      ) : null}
    </div>
  )
}
