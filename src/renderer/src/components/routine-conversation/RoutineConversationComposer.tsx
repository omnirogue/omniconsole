import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import { companiesData, conversationApi, conversationError } from './routine-conversation-data'
import type { BoardConversationTurn } from '../../../../shared/console-routine-conversation-contract'

export function RoutineConversationComposer({
  taskId,
  onPosted
}: {
  taskId: string
  onPosted: (turn: BoardConversationTurn) => void
}) {
  const id = useId()
  const [content, setContent] = useState('')
  const [sending, setSending] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const locked = useRef(false)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  async function send() {
    if (locked.current || !content.trim()) {
      return
    }
    locked.current = true
    setSending(true)
    setError('')
    setStatus('')
    try {
      const response = companiesData(
        await conversationApi().postMessage({ taskId, content: content.trim() })
      )
      if (!response.ok) {
        throw new Error(response.reason ?? response.code)
      }
      const turn = response.payload ?? response
      // Remember persisted turns even if the viewer switches runs during delivery.
      onPosted({ ...turn, role: 'user', content: turn.content ?? content.trim() })
      if (!live.current) {
        return
      }
      setContent('')
      const notices: string[] = []
      if (turn.delivered_live === true) {
        notices.push(translate('routineConversation.delivered', 'Delivered now'))
      }
      if (turn.queued_for_next_attempt === true) {
        notices.push(translate('routineConversation.queued', 'Queued for the next run'))
      }
      setStatus(notices.join(' · ') || translate('routineConversation.saved', 'Message saved.'))
    } catch (reason) {
      if (live.current) {
        setError(conversationError(reason))
      }
    } finally {
      locked.current = false
      if (live.current) {
        setSending(false)
      }
    }
  }
  return (
    <form
      className="space-y-2 border-t p-4"
      onSubmit={(event) => {
        event.preventDefault()
        void send()
      }}
    >
      <Label htmlFor={id}>{translate('routineConversation.message', 'Message the agent')}</Label>
      <Textarea
        id={id}
        value={content}
        disabled={sending}
        onChange={(event) => setContent(event.target.value)}
      />
      <Button size="sm" type="submit" disabled={sending || !content.trim()}>
        {sending
          ? translate('routineConversation.sending', 'Sending…')
          : translate('routineConversation.send', 'Send')}
      </Button>
      {status ? (
        <p role="status" className="text-xs text-muted-foreground">
          {status}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  )
}
