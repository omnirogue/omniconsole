import { useMemo, useState } from 'react'
import { useSidebarSessions } from '@/components/sidebar/session-folders/use-sidebar-sessions'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { InboxRoomPicker } from './InboxRoomPicker'
import { InboxRoomBriefFields } from './InboxRoomBriefFields'
import { InboxSessionExcerpt } from './InboxSessionExcerpt'
import { InboxRoomRecord } from './InboxRoomRecord'
import { roomSessionContext } from './inbox-room-context'
import { EMPTY_ROOM_BRIEF, formatRoomBrief } from './inbox-room-brief'
import { encodeRoomRecord, type RoomRecord } from './inbox-room-record'
import { peerInstruction } from './inbox-handoff'
import { translate as t } from '@/i18n/i18n'

export function InboxContextUpdate({
  project,
  roomId,
  sourcePostId,
  close,
  prepare
}: {
  project: string
  roomId: string
  sourcePostId?: string
  close: () => void
  prepare: (text: string) => void
}) {
  const sessions = useSidebarSessions()
  const options = useMemo(() => sessions.map(roomSessionContext), [sessions])
  const [selected, setSelected] = useState<string[]>([])
  const [title, setTitle] = useState('')
  const [brief, setBrief] = useState(EMPTY_ROOM_BRIEF)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<{ record: RoomRecord; instruction: string } | null>(null)
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          close()
        }
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto scrollbar-sleek sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('inbox.room.shareAContextUpdate', 'Share a context update')}</DialogTitle>
          <DialogDescription>
            {t(
              'inbox.room.reviewTheExactPublicTextEach',
              'Review the exact public text. Each update is a new room message; earlier versions remain in history.'
            )}
          </DialogDescription>
        </DialogHeader>
        {preview ? (
          <div className="space-y-4">
            <InboxRoomRecord record={preview.record} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setPreview(null)}>
                {t('inbox.room.edit', 'Edit')}
              </Button>
              <Button onClick={() => prepare(preview.instruction)}>
                {t('inbox.room.chooseMyAi', 'Choose my AI')}
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              try {
                const record: RoomRecord = {
                  kind: 'context_update',
                  title: title.trim(),
                  body: formatRoomBrief({
                    ...brief,
                    references: brief.references.map((url) => url.trim()).filter(Boolean)
                  }),
                  source_message_ids: sourcePostId ? [sourcePostId] : [],
                  open_questions: [],
                  ...(sourcePostId ? { supersedes_message_id: sourcePostId } : {})
                }
                const summary = encodeRoomRecord(record)
                const instruction = peerInstruction(project, 'room_send', {
                  room_id: roomId,
                  summary
                })
                setPreview({
                  record,
                  instruction: `${instruction}\n\nShare only the exact reviewed summary. Do not read more session content. If supersedes_message_id is present, verify the source message belongs to this room and was authored by your own employee identity before publishing; otherwise stop. This is an append-only update, not deletion or replacement of another person's contribution.`
                })
                setError('')
              } catch {
                setError(
                  'Add a title and shorten the public update to fit 1,200 characters and the room message limit. Check that reference links use HTTPS.'
                )
              }
            }}
          >
            <Label htmlFor="context-update-title">{t('inbox.room.title', 'Title')}</Label>
            <Input
              id="context-update-title"
              required
              maxLength={160}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
            <InboxRoomBriefFields value={brief} change={setBrief} />
            <InboxRoomPicker
              label={t('inbox.room.sourceSessionsOptional', 'Source sessions (optional)')}
              groups={[
                {
                  label: t('inbox.room.sessions', 'Sessions'),
                  options,
                  notice: 'Choose a session to read privately, or write your own update.'
                }
              ]}
              selected={options.filter((option) => selected.includes(option.key))}
              onChange={setSelected}
            />
            <InboxSessionExcerpt
              sessions={sessions.filter((session) =>
                selected.includes(`session:${session.rowKey}`)
              )}
              value={brief.excerpt ?? ''}
              change={(excerpt) => setBrief({ ...brief, excerpt })}
            />
            {sourcePostId && (
              <p className="text-xs text-muted-foreground">
                {t(
                  'inbox.room.updatesMessageOriginal',
                  'Updates message {{id}}. The original stays available.',
                  { id: sourcePostId }
                )}
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit">
              {t('inbox.room.previewSharedUpdate', 'Preview shared update')}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
