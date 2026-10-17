import { useEffect, useRef, useState } from 'react'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { readRoomSessionExcerpts } from './inbox-session-excerpt'
import { translate as t } from '@/i18n/i18n'

export function InboxSessionExcerpt({
  sessions,
  value,
  change
}: {
  sessions: SidebarSession[]
  value: string
  change: (value: string) => void
}) {
  const [excerpts, setExcerpts] = useState<{ id: string; text: string }[]>([])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const request = useRef({ generation: 0 })
  const identity = JSON.stringify(
    sessions.map(({ rowKey, sessionKey, agent, hostId, providerSession, unavailable }) => ({
      rowKey,
      sessionKey,
      agent,
      hostId,
      providerSession,
      unavailable
    }))
  )
  useEffect(() => {
    const guard = request.current
    guard.generation++
    setExcerpts([])
    setError('')
    setPending(false)
    return () => {
      guard.generation++
    }
  }, [identity])
  return (
    <details className="space-y-3 rounded-lg border p-3">
      <summary className="cursor-pointer text-sm font-medium">
        {t('inbox.room.chooseASessionExcerpt', 'Choose a session excerpt')}
      </summary>
      <p className="text-xs text-muted-foreground">
        {t(
          'inbox.room.readTheLastSixTurnsPrivately',
          'Read the last six turns privately, choose text, then edit the public excerpt. Nothing is shared by loading it.'
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        {sessions.map((session) => (
          <Button
            key={session.rowKey}
            type="button"
            variant="outline"
            size="sm"
            disabled={pending || session.unavailable}
            onClick={async () => {
              const current = ++request.current.generation
              setPending(true)
              setError('')
              setExcerpts([])
              try {
                const next = await readRoomSessionExcerpts(session)
                if (current === request.current.generation) {
                  setExcerpts(next.map((text) => ({ id: crypto.randomUUID(), text })))
                  if (!next.length) {
                    setError('No readable user or AI text was found.')
                  }
                }
              } catch (reason) {
                if (current === request.current.generation) {
                  setError(String(reason))
                }
              } finally {
                if (current === request.current.generation) {
                  setPending(false)
                }
              }
            }}
          >
            {pending
              ? t('inbox.room.reading', 'Reading…')
              : t('inbox.room.readSession', 'Read {{label}}', { label: session.label })}
          </Button>
        ))}
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="max-h-64 space-y-2 overflow-auto scrollbar-sleek">
        {excerpts.map(({ text, id }) => (
          <article key={id} className="space-y-2 rounded-md border p-3">
            <p className="whitespace-pre-wrap break-words text-xs">{text}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => change(text.slice(0, 800))}
            >
              {t('inbox.room.useExcerpt', 'Use excerpt')}
            </Button>
          </article>
        ))}
      </div>
      <Label htmlFor="room-session-excerpt">
        {t('inbox.room.publicExcerptUpTo800Characters', 'Public excerpt (up to 800 characters)')}
      </Label>
      <Textarea
        id="room-session-excerpt"
        rows={3}
        maxLength={800}
        value={value}
        onChange={(event) => change(event.target.value)}
      />
      {value && (
        <Button type="button" variant="ghost" size="sm" onClick={() => change('')}>
          {t('inbox.room.removeExcerpt', 'Remove excerpt')}
        </Button>
      )}
    </details>
  )
}
