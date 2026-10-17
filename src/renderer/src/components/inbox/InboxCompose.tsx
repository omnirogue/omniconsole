import { useEffect, useRef, useState } from 'react'
import { useHandoffScope } from '@/components/handoffs/handoff-scope'
import {
  clearPendingHandoff,
  recoverPendingHandoff,
  retainPendingHandoff
} from '@/components/handoffs/handoff-request-memory'
import { selectConsoleAccountScope } from '@/lib/console-account-scope'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { translate as t } from '@/i18n/i18n'
import type { InboxPerson } from './inbox-api'
import { inboxSend } from './inbox-api'
import { peerInstruction } from './inbox-handoff'
import { InboxRoomCompose } from './InboxRoomCompose'

export type ComposeKind = 'message' | 'room'
const NO_PEOPLE: InboxPerson[] = []
const NO_PREPARE = (_text: string): void => undefined
const COMPOSE_TARGET = 'peer:inbox:compose'
type InboxComposeProps = {
  kind?: ComposeKind
  project?: string
  people?: InboxPerson[]
  close: () => void
  prepare?: (text: string) => void
  onSent?: (recipient: InboxPerson) => void
}

export function InboxCompose(props: InboxComposeProps) {
  const scope = useHandoffScope()
  if (props.kind === 'room') {
    // Why: a room starts from searchable sessions and tasks with a reviewed brief (omni-brand
    // #228/#237), so the title plus hand-typed task ID form no longer opens for new rooms.
    return (
      <InboxRoomCompose
        key={`${scope}:room:${props.project}`}
        project={props.project ?? ''}
        agents={[]}
        close={props.close}
        prepare={props.prepare ?? NO_PREPARE}
      />
    )
  }
  return (
    <ScopedInboxCompose key={`${scope}:${props.kind}:${props.project}`} {...props} scope={scope} />
  )
}

function ScopedInboxCompose({
  kind = 'message',
  project = '',
  people = NO_PEOPLE,
  close,
  prepare,
  onSent,
  scope
}: InboxComposeProps & { scope: string }) {
  const [recovery] = useState(() =>
    kind === 'message' ? recoverPendingHandoff(scope, COMPOSE_TARGET) : { pending: null, error: '' }
  )
  const saved = recovery.pending?.kind === 'peer-send' ? recovery.pending : null
  const recoveryError =
    recovery.error ||
    (recovery.pending && !saved
      ? 'The saved request does not match this Inbox message. Restore it before sending.'
      : '')
  const [recipient, setRecipient] = useState(saved?.body.to ?? '')
  const [sending, setSending] = useState(false)
  const [locked, setLocked] = useState(!!saved)
  const intent = useRef(saved)
  const busy = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const current = () =>
    mounted.current && selectConsoleAccountScope(useAppStore.getState()) === scope
  const direct = kind === 'message'
  const [title, setTitle] = useState('')
  const [body, setBody] = useState(saved?.body.text ?? '')
  const [task, setTask] = useState('')
  const [error, setError] = useState('')
  const sendDirect = async () => {
    const person =
      people.find((entry) => entry.employee_id === recipient) ??
      (intent.current
        ? { employee_id: intent.current.body.to, name: intent.current.body.to, enrolled: true }
        : null)
    if (!person) {
      setError('Choose a colleague.')
      return
    }
    const text = body.trim()
    if (!text || new TextEncoder().encode(text).length > 2048) {
      setError('Write a message of at most 2 KB.')
      return
    }
    busy.current = true
    setSending(true)
    try {
      const pending =
        intent.current ??
        retainPendingHandoff(scope, COMPOSE_TARGET, {
          kind: 'peer-send',
          body: {
            to: person.employee_id,
            text,
            purpose: 'question',
            references: [],
            operationId: `omnios-inbox-${crypto.randomUUID()}`
          }
        })
      if (pending.kind !== 'peer-send') {
        throw new Error('The saved request does not match this Inbox message.')
      }
      intent.current = pending
      setLocked(true)
      await inboxSend({ ...pending.body, idempotencyKey: pending.body.operationId })
      if (!current()) {
        return
      }
      clearPendingHandoff(scope, COMPOSE_TARGET, pending.body.operationId)
      intent.current = null
      setLocked(false)
      onSent?.(person)
      close()
    } catch (reason) {
      if (current()) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    } finally {
      busy.current = false
      if (current()) {
        setSending(false)
      }
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !sending) {
          close()
        }
      }}
    >
      <DialogContent
        showCloseButton={!sending}
        className="max-h-[90vh] overflow-y-auto scrollbar-sleek sm:max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle>
            {kind === 'message'
              ? t('inbox.newMessage', 'New message')
              : t('inbox.newRoom', 'New room')}
          </DialogTitle>
          <DialogDescription>
            {direct
              ? t(
                  'inbox.composeHelpHuman',
                  'Write directly to a colleague’s Inbox. They can reply to the original message here.'
                )
              : t(
                  'inbox.composeHelp',
                  'Prepare the content, review it, then ask your AI to send it through the shared project. Nothing is sent while you type.'
                )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (busy.current || recoveryError || !current()) {
              return
            }
            setError('')
            if (direct) {
              void sendDirect()
              return
            }
            try {
              prepare?.(
                peerInstruction(project, 'room_create', {
                  name: title.trim(),
                  task_id: task.trim()
                })
              )
            } catch (reason) {
              setError(String(reason))
            }
          }}
        >
          {direct && (
            <div className="space-y-2">
              <Label htmlFor="inbox-recipient">{t('inbox.recipientPerson', 'To')}</Label>
              <Select
                value={recipient}
                onValueChange={setRecipient}
                disabled={sending || locked || !!recoveryError}
              >
                <SelectTrigger id="inbox-recipient">
                  <SelectValue placeholder={t('inbox.choosePerson', 'Choose a colleague')} />
                </SelectTrigger>
                <SelectContent>
                  {people.map((person) => (
                    <SelectItem key={person.employee_id} value={person.employee_id}>
                      {person.name} · {person.employee_id}
                      {person.enrolled ? '' : ` · ${t('inbox.notEnrolledYet', 'first message')}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {t(
                  'inbox.deliveryHelpHuman',
                  'Choose the exact employee. Sending is confirmed by their Inbox receipt.'
                )}
              </p>
            </div>
          )}
          {kind !== 'message' && (
            <>
              <div className="space-y-2">
                <Label htmlFor="inbox-title">{t('inbox.title', 'Title')}</Label>
                <Input
                  id="inbox-title"
                  required
                  maxLength={kind === 'room' ? 160 : 240}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={t('inbox.titlePlaceholder', 'Example: Search release coordination')}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="inbox-task">{t('inbox.task', 'Existing task ID')}</Label>
                <Input
                  id="inbox-task"
                  required
                  pattern="btk_[A-Za-z0-9]+"
                  value={task}
                  onChange={(e) => setTask(e.target.value)}
                  placeholder={t('inbox.compose.taskIdPlaceholder', 'btk_…')}
                />
                <p className="text-xs text-muted-foreground">
                  {t(
                    'inbox.taskHelp',
                    'Links the conversation to the existing work and its approval rules.'
                  )}
                </p>
              </div>
            </>
          )}
          {kind !== 'room' && (
            <div className="space-y-2">
              <Label htmlFor="inbox-body">{t('inbox.message', 'Message')}</Label>
              <Textarea
                disabled={sending || locked || !!recoveryError}
                id="inbox-body"
                required
                rows={5}
                maxLength={2048}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder={t(
                  'inbox.messagePlaceholder',
                  'Explain what you need, relevant context, and the expected next step.'
                )}
              />
            </div>
          )}
          {locked && (
            <p role="status" className="text-xs text-muted-foreground">
              {t(
                'inbox.retrySaved',
                'This message is saved. Retry checks the same recipient and message.'
              )}
            </p>
          )}
          {(recoveryError || error) && (
            <p role="alert" className="text-sm text-destructive">
              {recoveryError || error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={sending} onClick={close}>
              {locked ? t('inbox.close', 'Close') : t('inbox.cancel', 'Cancel')}
            </Button>
            <Button type="submit" disabled={sending || !!recoveryError}>
              {direct
                ? sending
                  ? t('inbox.sending', 'Sending…')
                  : locked
                    ? t('inbox.retryMessage', 'Retry message')
                    : t('inbox.send', 'Send')
                : t('inbox.prepare', 'Review AI instruction')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
