import { useId, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'
import {
  insertMention,
  mentionCandidates,
  mentionKeydown,
  mentionQuery,
  pruneMentions,
  type Mention,
  type MentionRegistry
} from '../../../../shared/room-mentions'
import type { RoomDetail, RoomSend } from '../../../../shared/rooms'
import { roomDraft } from './room-draft'

export function RoomComposer({
  detail,
  send,
  disabled = false
}: {
  detail: RoomDetail
  send(body: RoomSend): Promise<boolean>
  disabled?: boolean
}): React.JSX.Element {
  const [draft, setDraft] = useState(''),
    [caret, setCaret] = useState(0)
  const [registry, setRegistry] = useState<MentionRegistry>(new Set())
  const [index, setIndex] = useState(0),
    [dismissed, setDismissed] = useState(false),
    [sending, setSending] = useState(false)
  const textarea = useRef<HTMLTextAreaElement>(null),
    composing = useRef(false),
    busy = useRef(false)
  const pendingCaret = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (pendingCaret.current === null) {
      return
    }
    const position = pendingCaret.current
    pendingCaret.current = null
    textarea.current?.focus()
    textarea.current?.setSelectionRange(position, position)
  }, [draft])
  const attempt = useRef<{ key: string; eventId: string } | null>(null)
  const listId = useId()
  const query = dismissed ? null : mentionQuery(draft, caret)
  const candidates = query ? mentionCandidates(detail, query.query) : []
  const parsed = roomDraft(draft, detail, registry)
  const choose = (mention: Mention) => {
    if (!query) {
      return
    }
    const next = insertMention(draft, query, mention, registry)
    // Place the caret at commit time, before another keystroke can arrive.
    pendingCaret.current = next.caret
    setDraft(next.text)
    setRegistry(next.registry)
    setCaret(next.caret)
    setDismissed(true)
  }
  const submit = async () => {
    if (!parsed.valid || busy.current || disabled) {
      return
    }
    busy.current = true
    setSending(true)
    const body = {
      content: parsed.content,
      targetAgentIds: parsed.targetAgentIds,
      mentionedUserIds: parsed.mentionedUserIds
    }
    const key = JSON.stringify(body)
    if (attempt.current?.key !== key) {
      attempt.current = { key, eventId: crypto.randomUUID() }
    }
    try {
      if (await send({ ...body, eventId: attempt.current.eventId })) {
        setDraft('')
        setRegistry(new Set())
        setCaret(0)
        attempt.current = null
      }
    } finally {
      busy.current = false
      setSending(false)
    }
  }
  return (
    <div className="space-y-2 border-t border-border p-3">
      <div className="relative">
        {candidates.length > 0 && !sending ? (
          <div
            id={listId}
            role="listbox"
            aria-label={translate('rooms.mentions', 'Mention a participant')}
            className="scrollbar-sleek absolute bottom-full left-0 right-0 mb-1 max-h-72 overflow-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-floating"
          >
            {candidates.map((candidate, at) => (
              <button
                key={`${candidate.kind}:${candidate.id}`}
                id={`${listId}-${at}`}
                type="button"
                role="option"
                aria-selected={at === index}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(candidate)}
                className={`block w-full rounded-sm px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground ${at === index ? 'bg-accent text-accent-foreground ring-1 ring-ring' : ''}`}
              >
                @{candidate.label}{' '}
                <span className="text-xs text-muted-foreground">{candidate.id.slice(-8)}</span>
              </button>
            ))}
          </div>
        ) : null}
        <textarea
          ref={textarea}
          value={draft}
          disabled={disabled || sending}
          rows={3}
          aria-label={translate('rooms.message', 'Room message')}
          aria-controls={candidates.length ? listId : undefined}
          aria-activedescendant={candidates.length ? `${listId}-${index}` : undefined}
          placeholder={translate(
            'rooms.placeholder',
            'Write a message. Type @ to mention someone.'
          )}
          className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onChange={(event) => {
            setDraft(event.target.value)
            setCaret(event.target.selectionStart)
            setRegistry(pruneMentions(event.target.value, registry))
            setDismissed(false)
            setIndex(0)
          }}
          onCompositionStart={() => {
            composing.current = true
          }}
          onCompositionEnd={() => {
            composing.current = false
          }}
          onKeyDown={(event) => {
            const action = mentionKeydown(event.nativeEvent, {
              options: candidates.length,
              index,
              composing: composing.current
            })
            if (!action) {
              return
            }
            event.preventDefault()
            if (action.type === 'move') {
              setIndex(action.index)
            } else if (action.type === 'dismiss') {
              setDismissed(true)
            } else {
              choose(candidates[action.index])
            }
          }}
        />
      </div>
      <div
        className="flex flex-wrap gap-1"
        aria-label={translate('rooms.selectedMentions', 'Selected mentions')}
      >
        {parsed.spans.map((span, at) => (
          <Badge key={`${span.kind}:${span.id}:${at}`} variant="secondary" title={span.id}>
            @{span.label}
          </Badge>
        ))}
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {translate(
            'rooms.limits',
            '{{characters}}/3000 characters · {{agents}}/5 agents · {{people}}/20 people',
            {
              characters: parsed.content.length,
              agents: parsed.targetAgentIds.length,
              people: parsed.mentionedUserIds.length
            }
          )}
        </p>
        <Button
          size="sm"
          disabled={!parsed.valid || sending || disabled}
          onClick={() => void submit()}
        >
          {translate('rooms.send', 'Send')}
        </Button>
      </div>
    </div>
  )
}
