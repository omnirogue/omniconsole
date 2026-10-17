import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { Room, RoomAccountStatus, RoomPending, RoomsApi } from '../../../../shared/rooms'
import { RoomAccount } from './RoomAccount'
import { RoomList } from './RoomList'
import { RoomConversation } from './RoomConversation'
import { roomErrorText } from './room-error-text'

export function RoomsPage({ api, close }: { api: RoomsApi; close?(): void }): React.JSX.Element {
  const [status, setStatus] = useState<RoomAccountStatus | null>(null),
    [error, setError] = useState('')
  const [rooms, setRooms] = useState<Room[]>([]),
    [pending, setPending] = useState<RoomPending | null>(null)
  const [selected, setSelected] = useState<string | null>(null),
    [cursor, setCursor] = useState<string | null>(null)
  const [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0)
  const refresh = useCallback(() => setRevision((value) => value + 1), [])
  const linked = status?.state === 'linked'
  useEffect(() => {
    let current = true,
      reading = false
    const read = async () => {
      if (reading || document.hidden) {
        return
      }
      reading = true
      try {
        const result = await api.status()
        if (!current) {
          return
        }
        if (result.ok) {
          setStatus(result.data)
          if (result.data.error) {
            setError(roomErrorText(result.data.error))
          }
        } else {
          setStatus(null)
          setError(roomErrorText(result.error.code))
        }
      } catch {
        if (current) {
          setStatus(null)
          setError(roomErrorText('network_error'))
        }
      } finally {
        reading = false
      }
    }
    void read()
    const timer = setInterval(() => void read(), 2000)
    return () => {
      current = false
      clearInterval(timer)
    }
  }, [api, revision])
  useEffect(() => {
    if (!linked) {
      setRooms([])
      setPending(null)
      setSelected(null)
      return
    }
    let current = true
    const read = async () => {
      setBusy(true)
      setError('')
      try {
        const [list, summary] = await Promise.all([api.listRooms(), api.pendingSummary()])
        if (!current) {
          return
        }
        if (list.ok) {
          setRooms(list.data.rooms)
          setCursor(list.data.nextCursor)
        } else {
          setError(roomErrorText(list.error.code))
        }
        if (summary.ok) {
          setPending(summary.data)
        } else {
          setError(roomErrorText(summary.error.code))
        }
      } catch {
        if (current) {
          setError(roomErrorText('network_error'))
        }
      } finally {
        if (current) {
          setBusy(false)
        }
      }
    }
    void read()
    return () => {
      current = false
    }
  }, [api, linked, revision])
  const more = async () => {
    if (!cursor || busy) {
      return
    }
    setBusy(true)
    try {
      const result = await api.listRooms(cursor)
      if (result.ok) {
        setRooms((old) => [
          ...new Map([...old, ...result.data.rooms].map((room) => [room.id, room])).values()
        ])
        setCursor(result.data.nextCursor)
      } else {
        setError(roomErrorText(result.error.code))
      }
    } catch {
      setError(roomErrorText('network_error'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="flex items-center justify-between border-b border-border p-3">
        <h1 className="text-lg font-semibold">{translate('rooms.title', 'Online Rooms')}</h1>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={refresh}>
            {translate('rooms.refresh', 'Refresh')}
          </Button>
          {close ? (
            <Button size="sm" variant="ghost" onClick={close}>
              {translate('rooms.backToWork', 'Back to Work')}
            </Button>
          ) : null}
        </div>
      </header>
      <RoomAccount api={api} status={status} refresh={refresh} />
      {error ? (
        <p role="alert" className="p-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {linked ? (
        <div className="flex min-h-0 flex-1">
          <RoomList
            rooms={rooms}
            pending={pending}
            selected={selected}
            select={setSelected}
            busy={busy}
            more={cursor ? () => void more() : undefined}
          />
          {selected ? (
            <RoomConversation
              key={selected}
              api={api}
              id={selected}
              revision={revision}
              onRead={refresh}
            />
          ) : (
            <p className="p-6 text-sm text-muted-foreground">
              {translate('rooms.select', 'Choose a room to read or send messages.')}
            </p>
          )}
        </div>
      ) : null}
    </div>
  )
}
