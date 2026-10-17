import { useEffect, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { translate as t } from '@/i18n/i18n'
import {
  consoleWorkflowApi,
  workflowData,
  workflowErrorMessage
} from '@/lib/console-workflow-client'

/** The server chooses messaging authority; historical room IDs never become new rooms. */
export function DiscussionWriteBoundary({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'loading' | 'legacy' | 'moved' | 'unavailable'>('loading')
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let live = true
    setState('loading')
    setError('')
    void (async () => {
      try {
        const api = consoleWorkflowApi()
        if (typeof api.readCommunicationMode !== 'function') {
          throw new Error(
            t('discussions.modeUpdate', 'Update OmniConsole to check messaging availability.')
          )
        }
        const config = workflowData(await api.readCommunicationMode())
        if (live) {
          setState(
            config.mode === 'legacy' && !config.legacyWritesFenced
              ? 'legacy'
              : config.mode === 'omniconsole'
                ? 'moved'
                : 'unavailable'
          )
        }
      } catch (reason) {
        if (live) {
          setError(workflowErrorMessage(reason))
          setState('unavailable')
        }
      }
    })()
    return () => {
      live = false
    }
  }, [revision])
  if (state === 'legacy') {
    return children
  }
  return (
    <div className="space-y-2 text-xs text-muted-foreground">
      <p role={state === 'unavailable' ? 'alert' : 'status'}>
        {state === 'loading'
          ? t('discussions.checkingMode', 'Checking messaging availability…')
          : state === 'moved'
            ? t(
                'discussions.moved',
                'Messaging moved to OmniRogue Chats. This earlier conversation remains readable.'
              )
            : error ||
              t('discussions.modeUnavailable', 'Messaging is not configured on this connection.')}
      </p>
      {state !== 'loading' && (
        <Button size="sm" variant="ghost" onClick={() => setRevision((value) => value + 1)}>
          {t('discussions.checkAgain', 'Check again')}
        </Button>
      )}
    </div>
  )
}
