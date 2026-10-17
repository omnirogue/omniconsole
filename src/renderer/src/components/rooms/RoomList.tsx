import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { Room, RoomPending } from '../../../../shared/rooms'

export function RoomList({
  rooms,
  pending,
  selected,
  select,
  more,
  busy
}: {
  rooms: Room[]
  pending: RoomPending | null
  selected: string | null
  select(id: string): void
  more?: () => void
  busy: boolean
}): React.JSX.Element {
  return (
    <nav
      aria-label={translate('rooms.list', 'Your rooms')}
      className="scrollbar-sleek w-56 shrink-0 overflow-y-auto border-r border-border p-2"
    >
      {rooms.length === 0 ? (
        <p className="p-2 text-sm text-muted-foreground">
          {translate('rooms.empty', 'No rooms yet. Join a room on OmniRogue to see it here.')}
        </p>
      ) : null}
      {rooms.map((room) => {
        const summary = pending?.rooms.find((item) => item.roomId === room.id)
        return (
          <Button
            key={room.id}
            variant="ghost"
            disabled={room.status === 'pending'}
            data-current={room.id === selected}
            className={`mb-1 h-auto w-full justify-start whitespace-normal py-2 text-left ${room.id === selected ? 'bg-accent text-accent-foreground' : ''}`}
            onClick={() => select(room.id)}
          >
            <span className="min-w-0">
              <span className="block truncate">{room.name}</span>
              {summary ? (
                <span className="text-xs text-muted-foreground">
                  {translate('rooms.pending', '{{unread}} unread · {{mentions}} mentions', {
                    unread: summary.pendingCount,
                    mentions: summary.mentionCount ?? 0
                  })}
                </span>
              ) : null}
            </span>
          </Button>
        )
      })}
      {more ? (
        <Button variant="ghost" size="sm" disabled={busy} onClick={more}>
          {translate('rooms.more', 'Load more rooms')}
        </Button>
      ) : null}
    </nav>
  )
}
