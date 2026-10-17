import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import type { RoomAccountStatus, RoomsApi, RoomResult } from '../../../../shared/rooms'
import { roomErrorText } from './room-error-text'

export function RoomAccount({
  api,
  status,
  refresh
}: {
  api: RoomsApi
  status: RoomAccountStatus | null
  refresh(): void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const [apiOrigin, setApiOrigin] = useState(''),
    [frontendOrigin, setFrontendOrigin] = useState('')
  const run = async (operation: () => Promise<RoomResult<unknown>>) => {
    if (busy) {
      return
    }
    setBusy(true)
    setError('')
    try {
      const result = await operation()
      if (!result.ok) {
        setError(roomErrorText(result.error.code))
      }
      refresh()
    } catch {
      setError(roomErrorText('network_error'))
    } finally {
      setBusy(false)
    }
  }
  const linked = status?.state === 'linked'
  return (
    <div className="space-y-2 border-b border-border px-3 py-2">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-muted-foreground">
          {linked
            ? translate('rooms.linked', 'OmniRogue account linked')
            : status?.state === 'linking'
              ? translate('rooms.linking', 'Waiting for browser approval…')
              : translate('rooms.unlinked', 'Link an OmniRogue account to open your rooms.')}
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void run(() => (linked ? api.unlink() : api.link()))}
        >
          {linked
            ? translate('rooms.unlink', 'Unlink account')
            : translate('rooms.link', 'Link account')}
        </Button>
      </div>
      {!linked ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">
            {translate('rooms.addresses', 'Fallback service addresses')}
          </summary>
          <form
            className="mt-2 flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              void run(() => api.configure({ apiOrigin, frontendOrigin }))
            }}
          >
            <label className="space-y-1">
              {translate('rooms.apiOrigin', 'OmniRogue API origin')}
              <Input
                type="url"
                required
                value={apiOrigin}
                onChange={(event) => setApiOrigin(event.target.value)}
              />
            </label>
            <label className="space-y-1">
              {translate('rooms.frontendOrigin', 'OmniRogue website origin')}
              <Input
                type="url"
                required
                value={frontendOrigin}
                onChange={(event) => setFrontendOrigin(event.target.value)}
              />
            </label>
            <Button size="sm" variant="outline" disabled={busy} type="submit">
              {translate('rooms.saveAddresses', 'Save addresses')}
            </Button>
          </form>
        </details>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
