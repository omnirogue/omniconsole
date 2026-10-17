import React, { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import { sendSessionReply } from '@/lib/session-reply-send'
import type { SidebarSession } from '@/lib/sidebar-sessions'

const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')

/** A follow-up written on the project page and sent into the thread without opening it. */
export function SessionProjectThreadReplyForm({
  session,
  onClose
}: {
  session: SidebarSession
  onClose: () => void
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const sending = useRef(false)
  const send = async (): Promise<void> => {
    const message = text.trim()
    if (sending.current || !message) {
      return
    }
    sending.current = true
    setPending(true)
    setError(undefined)
    try {
      await sendSessionReply(session, message)
      toast.success(
        translate('projects.reply.sent', 'Sent to {{label}}.', {
          label: session.label
        })
      )
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      sending.current = false
      setPending(false)
    }
  }
  return (
    <form
      className="space-y-1.5 px-2 pb-2"
      data-session-project-reply={session.rowKey}
      onSubmit={(event) => {
        event.preventDefault()
        void send()
      }}
    >
      <Textarea
        autoFocus
        rows={2}
        maxLength={8_000}
        value={text}
        disabled={pending}
        aria-label={translate('projects.reply.label', 'Reply to {{label}}', {
          label: session.label
        })}
        placeholder={translate('projects.reply.placeholder', 'Send a follow-up to this thread…')}
        className="min-h-14 resize-y text-sm"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (isMac ? event.metaKey : event.ctrlKey)) {
            event.preventDefault()
            void send()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
          }
        }}
      />
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-1.5">
        <Button type="button" size="xs" variant="ghost" disabled={pending} onClick={onClose}>
          {translate('projects.reply.cancel', 'Cancel')}
        </Button>
        <Button type="submit" size="xs" disabled={pending || !text.trim()}>
          {translate('projects.reply.send', 'Send')}
        </Button>
      </div>
    </form>
  )
}
