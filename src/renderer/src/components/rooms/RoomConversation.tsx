import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { RoomDetail, RoomSnapshot, RoomsApi } from '../../../../shared/rooms'
import { RoomThread } from './RoomThread'
import { RoomComposer } from './RoomComposer'
import { RoomAgentRoster } from './RoomAgentRoster'
import { roomErrorText } from './room-error-text'

const EMPTY: RoomSnapshot = { events: [], sequence: '0', gaps: [], retryMs: 2000 }
export function RoomConversation({
  api,
  id,
  revision = 0,
  onRead
}: {
  api: RoomsApi
  id: string
  revision?: number
  onRead(): void
}): React.JSX.Element {
  const [detail, setDetail] = useState<RoomDetail | null>(null),
    [snapshot, setSnapshot] = useState(EMPTY)
  const [error, setError] = useState(''),
    [acknowledging, setAcknowledging] = useState(false)
  useEffect(() => {
    let current = true
    const apply = (next: RoomSnapshot) => {
      if (current) {
        setSnapshot((previous) =>
          next.error === 'device_unauthorized' ||
          next.error === 'forbidden' ||
          next.error === 'connection_changed' ||
          BigInt(next.sequence) >= BigInt(previous.sequence)
            ? next
            : previous
        )
      }
    }
    const loadDetail = async () => {
      if (document.hidden) {
        return
      }
      try {
        const result = await api.getRoom(id)
        if (!current) {
          return
        }
        if (result.ok) {
          setDetail(result.data)
          setError('')
        } else {
          setError(roomErrorText(result.error.code))
          setDetail(null)
        }
      } catch {
        if (current) {
          setError(roomErrorText('network_error'))
        }
      }
    }
    const syncWatchTarget = async () => {
      try {
        const result = await api.setWatchedRoom(document.hidden ? null : id)
        if (!current) {
          return
        }
        if (result.ok && result.data) {
          apply(result.data)
        } else if (!result.ok) {
          setError(roomErrorText(result.error.code))
        }
      } catch {
        if (current) {
          setError(roomErrorText('network_error'))
        }
      }
    }
    const unsubscribe = api.onSnapshot((payload) => {
      if (payload.roomId === id) {
        apply(payload.snapshot)
      }
    })
    const visibility = () => {
      void syncWatchTarget()
      void loadDetail()
    }
    document.addEventListener('visibilitychange', visibility)
    visibility()
    const timer = setInterval(() => void loadDetail(), 10000)
    return () => {
      current = false
      clearInterval(timer)
      unsubscribe()
      document.removeEventListener('visibilitychange', visibility)
      void api.setWatchedRoom(null)
    }
  }, [api, id, revision])
  const ack = async () => {
    if (acknowledging) {
      return
    }
    setAcknowledging(true)
    try {
      const result = await api.ack(id, snapshot.sequence)
      if (result.ok) {
        setError('')
        onRead()
      } else {
        setError(roomErrorText(result.error.code))
      }
    } catch {
      setError(roomErrorText('network_error'))
    } finally {
      setAcknowledging(false)
    }
  }
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-border px-3 py-2">
        <h2 className="truncate text-sm font-semibold">
          {detail?.name ?? translate('rooms.loading', 'Loading room…')}
        </h2>
        <Button
          size="sm"
          variant="ghost"
          disabled={!detail || acknowledging || snapshot.sequence === '0'}
          onClick={() => void ack()}
        >
          {translate('rooms.markRead', 'Mark read')}
        </Button>
      </header>
      {detail ? <RoomAgentRoster agents={detail.agents} /> : null}
      {error || snapshot.error ? (
        <p role="alert" className="px-3 py-2 text-sm text-destructive">
          {error || (snapshot.error ? roomErrorText(snapshot.error) : '')}
        </p>
      ) : null}
      {snapshot.gaps.length ? (
        <p role="status" className="px-3 py-1 text-xs text-muted-foreground">
          {translate(
            'rooms.gap',
            'Some event sequence numbers were skipped. Showing the events received.'
          )}
        </p>
      ) : null}
      {detail ? (
        <>
          <RoomThread events={snapshot.events} currentUserId={detail.currentUserId} />
          {detail.membersTruncated ? (
            <p className="px-3 text-xs text-muted-foreground">
              {translate(
                'rooms.rosterTruncated',
                'Mentions are limited to the members included in this room’s roster page.'
              )}
            </p>
          ) : null}
          <RoomComposer
            detail={detail}
            disabled={snapshot.error === 'device_unauthorized' || snapshot.error === 'forbidden'}
            send={async (body) => {
              try {
                const result = await api.send(id, body)
                setError(result.ok ? '' : roomErrorText(result.error.code))
                return result.ok
              } catch {
                setError(roomErrorText('network_error'))
                return false
              }
            }}
          />
        </>
      ) : null}
    </section>
  )
}
