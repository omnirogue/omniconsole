import { useId, useState } from 'react'
import { Switch } from '@/components/ui/switch'
import { translate } from '@/i18n/i18n'
import {
  setLaunchSessionContextPinned,
  useLaunchSessionContextPinned
} from '@/lib/launch-session-context'

/** The launcher's "Keep for future sessions" switch; off by default, so context rides once. */
export function LaunchContextKeepToggle({ contextKey }: { contextKey: string }) {
  const pinned = useLaunchSessionContextPinned(contextKey)
  const [error, setError] = useState('')
  const id = useId()
  return (
    <div className="mt-3 space-y-1 border-t pt-2" data-launch-context-kept={pinned}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-xs font-medium">
          {translate('sessionContext.keep', 'Keep for future sessions')}
        </label>
        <Switch
          id={id}
          checked={pinned}
          onCheckedChange={(checked) => {
            setError('')
            try {
              setLaunchSessionContextPinned(contextKey, checked)
            } catch (reason) {
              setError(reason instanceof Error ? reason.message : String(reason))
            }
          }}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {pinned
          ? translate(
              'sessionContext.keepOn',
              'Added to every new session started here until you turn this off.'
            )
          : translate('sessionContext.keepOff', 'Added to the next session only, then cleared.')}
      </p>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
