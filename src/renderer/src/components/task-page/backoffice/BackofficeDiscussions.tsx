import { useVisiblePeerProject } from './use-visible-peer-project'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate as t } from '@/i18n/i18n'
import { peerMessageProjects } from '@/lib/peer-messages'
import { readPeerRooms } from '@/lib/peer-rooms'
import type { PeerRoom } from '../../../../../shared/peer-room-contract'
import { BackofficeDiscussionDetail } from './BackofficeDiscussionDetail'
import { DiscussionComposeAction } from '@/components/inbox/DiscussionComposeAction'

export function BackofficeDiscussions({ onOpenTask }: { onOpenTask: (id: string) => void }) {
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([])
  const [project, setProject] = useState('')
  useVisiblePeerProject(project)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let live = true
    setError('')
    void peerMessageProjects().then(
      (value) => {
        if (live) {
          setProjects(value)
          setProject((current) =>
            value.some((item) => item.id === current) ? current : (value[0]?.id ?? '')
          )
        }
      },
      (reason: unknown) => {
        if (live) {
          setProjects([])
          setProject('')
          setError(String(reason))
        }
      }
    )
    return () => {
      live = false
    }
  }, [revision])
  return (
    <section
      className="flex min-h-0 flex-1 flex-col"
      aria-label={t('discussions.title', 'Discussions')}
    >
      <div className="flex items-center gap-2 border-b p-3">
        <Select value={project} onValueChange={setProject}>
          <SelectTrigger aria-label={t('discussions.project', 'Discussion project')}>
            <SelectValue placeholder={t('discussions.choose', 'Choose a project')} />
          </SelectTrigger>
          <SelectContent>
            {projects.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="ghost" size="sm" onClick={() => setRevision((value) => value + 1)}>
          {t('discussions.refresh', 'Refresh discussions')}
        </Button>
        <DiscussionComposeAction
          key={project}
          kind="room"
          project={project}
          refresh={() => setRevision((value) => value + 1)}
        />
      </div>
      {error && (
        <p role="alert" className="p-3 text-sm text-destructive">
          {error}
        </p>
      )}
      {project ? (
        <ProjectDiscussions
          key={`${project}:${revision}`}
          project={project}
          onOpenTask={onOpenTask}
        />
      ) : (
        <p className="p-3 text-sm text-muted-foreground">
          {t('discussions.noProject', 'No discussion project is available.')}
        </p>
      )}
    </section>
  )
}

function ProjectDiscussions({
  project,
  onOpenTask
}: {
  project: string
  onOpenTask: (id: string) => void
}) {
  const [rooms, setRooms] = useState<PeerRoom[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [cursor, setCursor] = useState<string | undefined>()
  const [next, setNext] = useState<string | null>(null)
  const [pending, setPending] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    setPending(true)
    void readPeerRooms(project, cursor)
      .then(
        (page) => {
          if (live) {
            setRooms((current) => [
              ...new Map([...current, ...page.rooms].map((room) => [room.id, room])).values()
            ])
            setNext(page.next_cursor === cursor ? null : page.next_cursor)
            setError('')
          }
        },
        (reason: unknown) => {
          if (live) {
            setRooms([])
            setNext(null)
            setSelected(null)
            setError(String(reason))
          }
        }
      )
      .finally(() => {
        if (live) {
          setPending(false)
        }
      })
    return () => {
      live = false
    }
  }, [project, cursor])
  return (
    <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
      <div className="overflow-auto scrollbar-sleek border-r p-3">
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {pending && <p role="status">{t('discussions.loading', 'Loading discussions…')}</p>}
        {!pending && !error && !rooms.length && (
          <p>{t('discussions.empty', 'No discussions returned for this project.')}</p>
        )}
        <ul>
          {rooms.map((room) => (
            <li key={room.id}>
              <Button
                variant={selected === room.id ? 'secondary' : 'ghost'}
                className="h-auto w-full justify-start whitespace-normal text-left"
                onClick={() => setSelected(room.id)}
              >
                {room.name} · {room.state}
              </Button>
            </li>
          ))}
        </ul>
        {next && (
          <Button variant="outline" size="sm" disabled={pending} onClick={() => setCursor(next)}>
            {t('discussions.more', 'Load more discussions')}
          </Button>
        )}
      </div>
      <div className="overflow-auto scrollbar-sleek p-3">
        {selected && (
          <BackofficeDiscussionDetail
            key={selected}
            project={project}
            roomId={selected}
            onOpenTask={onOpenTask}
          />
        )}
      </div>
    </div>
  )
}
