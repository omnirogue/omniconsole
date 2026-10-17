import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate as t } from '@/i18n/i18n'
import { BackofficeDiscussions } from '@/components/task-page/backoffice/BackofficeDiscussions'
import { InboxRequests } from './InboxRequests'
import { RoomsPage } from '../rooms/RoomsPage'

export function DiscussionWorkspace({
  scope,
  onOpenTask
}: {
  scope: string
  onOpenTask: (id: string) => void
}) {
  const [mode, setMode] = useState<'messages' | 'rooms' | 'online'>('messages')
  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <nav
        className="flex gap-2 border-b px-3 py-2"
        aria-label={t('discussions.conversations', 'Discussion conversations')}
      >
        <Button
          size="sm"
          variant={mode === 'messages' ? 'secondary' : 'ghost'}
          aria-pressed={mode === 'messages'}
          onClick={() => setMode('messages')}
        >
          {t('inbox.messages', 'Messages')}
        </Button>
        <Button
          size="sm"
          variant={mode === 'rooms' ? 'secondary' : 'ghost'}
          aria-pressed={mode === 'rooms'}
          onClick={() => setMode('rooms')}
        >
          {t('inbox.rooms', 'Rooms')}
        </Button>
        {window.api.rooms ? (
          <Button
            size="sm"
            variant={mode === 'online' ? 'secondary' : 'ghost'}
            aria-pressed={mode === 'online'}
            onClick={() => setMode('online')}
          >
            {t('rooms.title', 'Online Rooms')}
          </Button>
        ) : null}
      </nav>
      {mode === 'online' && window.api.rooms ? (
        <RoomsPage api={window.api.rooms} />
      ) : mode === 'rooms' ? (
        <BackofficeDiscussions onOpenTask={onOpenTask} />
      ) : (
        <InboxRequests scope={scope} kind="messages" onOpenTask={onOpenTask} />
      )}
    </section>
  )
}
