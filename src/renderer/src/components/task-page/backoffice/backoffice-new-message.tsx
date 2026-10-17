import { useId, useState } from 'react'
import { MessageSquarePlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useHandoffScope } from '@/components/handoffs/handoff-scope'
import { CommunicationTypeSelect } from '@/components/next-step/CommunicationTypeSelect'
import { SessionFollowUpRecipientPicker } from '@/components/session-follow-up/SessionFollowUpRecipientPicker'
import { useChatTagDelivery } from '@/components/native-chat/use-chat-tag-delivery'
import { useNativeChatDraft } from '@/components/native-chat/use-native-chat-draft'
import { writeNativeChatDraftCache } from '@/components/native-chat/native-chat-draft-cache'
import { translate } from '@/i18n/i18n'
import type { TeamRosterPerson } from '../../../../../shared/team-roster-search'

const COMPOSE_KEY = 'work-new-message'
const ignoreCaret = (): void => {}

/** One saved compose scope, using the same human handoff and retry as a person tag. */
export function BackofficeNewMessage({ onSent }: { onSent: () => void }): React.JSX.Element {
  const scope = useHandoffScope()
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <MessageSquarePlus className="size-3.5" />
        {translate('workNewMessage.open', 'New message')}
      </Button>
      {open && (
        <NewMessageDialog
          key={scope}
          scope={scope}
          onClose={() => setOpen(false)}
          onSent={onSent}
        />
      )}
    </>
  )
}

function NewMessageDialog({
  scope,
  onClose,
  onSent
}: {
  scope: string
  onClose: () => void
  onSent: () => void
}): React.JSX.Element {
  const id = useId()
  const draftKey = `${scope}:${COMPOSE_KEY}`
  const { draft, setDraft } = useNativeChatDraft(draftKey)
  const delivery = useChatTagDelivery({
    paneKey: COMPOSE_KEY,
    draft,
    setDraft,
    setCaret: ignoreCaret,
    mentionQuery: null,
    onSent: () => {
      // Closing unmounts before the draft hook's queued state update can clear its cache.
      writeNativeChatDraftCache(draftKey, '')
      onSent()
      onClose()
    }
  })
  const busy = delivery.pending || delivery.attaching
  const frozen = busy || delivery.retrySaved
  const roster = delivery.people.phase === 'ready' ? delivery.people.value : []
  const selected = delivery.recipients.map(
    (recipient) => roster.find((person) => person.id === recipient.id) ?? recipient
  )
  const choosePeople = (people: TeamRosterPerson[]): void => {
    for (const previous of delivery.recipients) {
      if (!people.some((person) => person.id === previous.id)) {
        delivery.remove(previous.id, previous.kind)
      }
    }
    for (const person of people) {
      delivery.choose({ kind: 'person', id: person.id, name: person.name })
    }
  }
  const tooLong = draft.length > 8192
  const error = tooLong
    ? ''
    : delivery.error || (delivery.people.phase === 'error' ? delivery.people.message : '')
  const canSend =
    !busy &&
    !delivery.blocked &&
    delivery.recipients.length > 0 &&
    draft.trim().length > 0 &&
    !tooLong
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{translate('workNewMessage.open', 'New message')}</DialogTitle>
          <DialogDescription>
            {translate(
              'workNewMessage.description',
              'Send directly to an employee. Replies stay with the message in Work.'
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (canSend) {
              void delivery.send()
            }
          }}
        >
          <div className="space-y-2">
            <Label htmlFor={`${id}-to`}>{translate('chatDelivery.to', 'To')}</Label>
            <SessionFollowUpRecipientPicker
              id={`${id}-to`}
              roster={roster}
              selected={selected}
              loading={delivery.people.phase === 'loading'}
              disabled={frozen || delivery.people.phase === 'error'}
              onChange={choosePeople}
            />
          </div>
          <CommunicationTypeSelect
            value={delivery.type}
            onChange={delivery.setType}
            disabled={frozen}
          />
          <div className="space-y-2">
            <Label htmlFor={`${id}-message`}>
              {translate('workNewMessage.message', 'Message')}
            </Label>
            <Textarea
              id={`${id}-message`}
              value={draft}
              rows={6}
              disabled={frozen}
              aria-invalid={tooLong}
              onChange={(event) => setDraft(event.target.value)}
            />
            {tooLong && (
              <p role="alert" className="text-xs text-destructive">
                {translate(
                  'workNewMessage.tooLong',
                  'Messages can contain up to 8,192 characters.'
                )}
              </p>
            )}
          </div>
          {delivery.retrySaved && (
            <p role="status" className="text-xs text-muted-foreground">
              {translate(
                'workNewMessage.retrySaved',
                'Your message is saved. Retry to confirm delivery to the remaining recipients.'
              )}
            </p>
          )}
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
              {translate('auto.components.ui.dialog.f26c4baeda', 'Close')}
            </Button>
            <Button type="submit" disabled={!canSend}>
              {delivery.pending
                ? translate('chatDelivery.sending', 'Sending…')
                : delivery.retrySaved
                  ? translate('workNewMessage.retry', 'Retry saved message')
                  : translate('workNewMessage.send', 'Send message')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
