import { useEffect, useMemo, useState } from 'react'
import { useSidebarSessions } from '@/components/sidebar/session-folders/use-sidebar-sessions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { translate as t } from '@/i18n/i18n'
import { inboxDirectory, type InboxAgent } from './inbox-api'
import { useInboxPeopleState } from './use-inbox-people'
import { roomParticipants } from './inbox-room-participants'
import { InboxRoomPicker } from './InboxRoomPicker'
import { InboxSessionExcerpt } from './InboxSessionExcerpt'
import { InboxRoomBriefFields } from './InboxRoomBriefFields'
import { EMPTY_ROOM_BRIEF } from './inbox-room-brief'
import {
  roomInstruction,
  roomOpeningMessage,
  roomSessionContext,
  roomTaskContexts,
  type RoomContext
} from './inbox-room-context'

export function InboxRoomCompose({
  project,
  agents,
  close,
  prepare
}: {
  project: string
  agents: InboxAgent[]
  close: () => void
  prepare: (text: string) => void
}) {
  const sessions = useSidebarSessions()
  const sessionOptions = useMemo(() => sessions.map(roomSessionContext), [sessions])
  const [tasks, setTasks] = useState<RoomContext[]>([])
  const [taskNotice, setTaskNotice] = useState('')
  const [revision, setRevision] = useState(0)
  const [contexts, setContexts] = useState<RoomContext[]>([])
  const [participants, setParticipants] = useState<string[]>([])
  const [title, setTitle] = useState('')
  const [brief, setBrief] = useState(EMPTY_ROOM_BRIEF)
  const [preview, setPreview] = useState<{ instruction: string; opening: string } | null>(null)
  const [request, setRequest] = useState('')
  const [error, setError] = useState('')
  const [peopleRevision, setPeopleRevision] = useState(0)
  const roster = useInboxPeopleState(peopleRevision)
  const [directory, setDirectory] = useState(agents)
  const [directoryError, setDirectoryError] = useState('')
  const [directoryLoading, setDirectoryLoading] = useState(true)
  useEffect(() => {
    let live = true
    setDirectoryLoading(true)
    setDirectoryError('')
    void inboxDirectory(project)
      .then((value) => {
        if (live) {
          setDirectory(value)
        }
      })
      .catch((reason: unknown) => {
        if (live) {
          setDirectory([])
          setDirectoryError(reason instanceof Error ? reason.message : String(reason))
        }
      })
      .finally(() => {
        if (live) {
          setDirectoryLoading(false)
        }
      })
    return () => {
      live = false
    }
  }, [project, peopleRevision])
  const participantOptions = useMemo(
    () =>
      roomParticipants(roster.people, directory, project).map((item) => ({
        ...item,
        disabled: item.disabled || roster.loading || directoryLoading || !!directoryError
      })),
    [roster.people, roster.loading, directory, directoryLoading, directoryError, project]
  )
  useEffect(() => {
    let live = true
    setTasks([])
    setTaskNotice(t('inbox.room.loadingTasks', 'Loading your tasks…'))
    void window.api.backoffice
      .listTodo()
      .then((result) => {
        if (!live) {
          return
        }
        if (!result.ok) {
          throw new Error(result.message)
        }
        const choices = roomTaskContexts(result.items, project)
        setTasks(choices)
        setTaskNotice(
          result.truncated
            ? t('inbox.room.partialTasks', 'Showing the loaded page of your tasks in this project.')
            : t('inbox.room.taskScope', 'Your tasks in this shared project.')
        )
      })
      .catch((reason: unknown) => {
        if (live) {
          setTaskNotice(reason instanceof Error ? reason.message : String(reason))
        }
      })
    return () => {
      live = false
    }
  }, [project, revision])
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
          <DialogTitle>{t('inbox.newRoom', 'New room')}</DialogTitle>
          <DialogDescription>
            {t(
              'inbox.room.help',
              'Ask other AIs for help with a session, discuss a task, or assess a decision together.'
            )}
          </DialogDescription>
        </DialogHeader>
        {preview ? (
          <div className="space-y-4">
            <p className="text-sm">
              {t(
                'inbox.room.reviewExactlyWhatWillBeShared',
                'Review exactly what will be shared with the room. Session identifiers are sent only to your own AI.'
              )}
            </p>
            <pre className="max-h-80 overflow-auto scrollbar-sleek whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 text-xs">
              {preview.opening}
            </pre>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setPreview(null)}>
                {t('inbox.room.editBrief', 'Edit brief')}
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
              setError('')
              try {
                if (
                  participants.some(
                    (id) => !participantOptions.some((item) => item.key === id && !item.disabled)
                  )
                ) {
                  throw new Error(
                    'A participant has no available AI conversation in this project. Choose participants again.'
                  )
                }
                const sharedBrief = {
                  ...brief,
                  references: brief.references.map((url) => url.trim()).filter(Boolean)
                }
                setPreview({
                  instruction: roomInstruction(
                    project,
                    title,
                    request,
                    participants,
                    contexts,
                    sharedBrief
                  ),
                  opening: roomOpeningMessage(request, contexts, sharedBrief)
                })
              } catch (reason) {
                setError(reason instanceof Error ? reason.message : String(reason))
              }
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="room-title">{t('inbox.title', 'Title')}</Label>
              <Input
                id="room-title"
                autoFocus
                required
                maxLength={160}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={t(
                  'inbox.room.titlePlaceholder',
                  'Example: Help investigate the sign-in issue'
                )}
              />
            </div>
            <InboxRoomBriefFields value={brief} change={setBrief} />
            <InboxRoomPicker
              label={t('inbox.room.participants', 'Participants')}
              groups={[
                {
                  label: t('inbox.room.participants', 'Participants'),
                  options: participantOptions,
                  notice:
                    roster.loading || directoryLoading
                      ? t('inbox.room.peopleLoading', 'Loading colleagues…')
                      : roster.error ||
                        directoryError ||
                        t(
                          'inbox.room.peopleHelp',
                          'All colleagues you can contact. AI setup is required to join a room. An AI Inbox is not a live IDE connection; replies arrive when their AI checks it.'
                        ),
                  retry: () => setPeopleRevision((value) => value + 1)
                }
              ]}
              selected={participantOptions.filter((item) => participants.includes(item.key))}
              onChange={setParticipants}
            />
            <InboxRoomPicker
              label={t('inbox.room.context', 'Context (optional)')}
              groups={[
                {
                  label: t('inbox.room.sessions', 'Sessions'),
                  options: sessionOptions,
                  notice: t(
                    'inbox.room.sessionScope',
                    'Your open and restorable sessions, including remote workspaces. Private conversation history is not shared automatically.'
                  )
                },
                {
                  label: t('inbox.room.tasks', 'Tasks'),
                  options: tasks,
                  notice: taskNotice,
                  retry: () => setRevision((value) => value + 1)
                }
              ]}
              selected={contexts}
              onChange={(keys) => {
                const available = new Map(
                  [...contexts, ...sessionOptions, ...tasks].map((item) => [item.key, item])
                )
                setContexts(
                  keys.flatMap((key) => (available.has(key) ? [available.get(key)!] : []))
                )
              }}
            />
            <InboxSessionExcerpt
              sessions={sessions.filter((session) =>
                contexts.some((context) => context.key === `session:${session.rowKey}`)
              )}
              value={brief.excerpt ?? ''}
              change={(excerpt) => setBrief({ ...brief, excerpt })}
            />
            <div className="space-y-2">
              <Label htmlFor="room-request">
                {t('inbox.room.request', 'What do you need help with?')}
              </Label>
              <Textarea
                id="room-request"
                required
                rows={3}
                maxLength={1600}
                value={request}
                onChange={(event) => setRequest(event.target.value)}
                placeholder={t(
                  'inbox.room.requestPlaceholder',
                  'Describe the question, blocker, or decision you want to discuss.'
                )}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {t(
                'inbox.room.reviewHelp',
                'Review the instruction before sending it to your AI. Linking context does not invite its owner or change the work.'
              )}
            </p>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={close}>
                {t('inbox.cancel', 'Cancel')}
              </Button>
              <Button type="submit">{t('inbox.prepare', 'Review AI instruction')}</Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
