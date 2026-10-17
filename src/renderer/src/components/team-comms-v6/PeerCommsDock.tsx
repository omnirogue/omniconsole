import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { AlertCircle, Bot, Check, CheckCheck, Clock, Hash, RotateCw, Send, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'

export type PeerKind = 'agent' | 'teammate'
export type PeerPresence = 'online' | 'busy' | 'away' | 'offline'
export type PeerDelivery = 'sending' | 'sent' | 'delivered' | 'read' | 'failed'
export type PeerCommsPeer = {
  id: string
  name: string
  kind: PeerKind
  presence: PeerPresence
  lastSeenAt?: number
}
export type PeerCommsRoom = { id: string; name: string; memberIds: string[] }
export type PeerCommsMessage = {
  id: string
  /** `dm:<peerId>` or `room:<roomId>`; build with `dmThreadId` / `roomThreadId`. */
  threadId: string
  authorId: string
  body: string
  sentAt: number
  /** Own messages: recipient receipt. Incoming: 'read' once the local user has seen it. */
  delivery: PeerDelivery
  readBy?: string[]
  /** Echo of the `clientId` passed to `onSend`; replaces the optimistic copy. */
  clientId?: string
}
export type PeerCommsSendInput = { threadId: string; body: string; clientId: string }
export type PeerCommsDockProps = {
  selfId: string
  peers: PeerCommsPeer[]
  rooms: PeerCommsRoom[]
  messages: PeerCommsMessage[]
  /** Resolve once the transport accepted the message; reject marks it failed. */
  onSend: (input: PeerCommsSendInput) => Promise<void>
  onMarkRead?: (threadId: string, messageIds: string[]) => void
  onClose?: () => void
  initialThreadId?: string
  className?: string
}

export const dmThreadId = (peerId: string): string => `dm:${peerId}`
export const roomThreadId = (roomId: string): string => `room:${roomId}`

type ThreadGroup = PeerKind | 'room'
type ThreadEntry = { threadId: string; label: string; group: ThreadGroup; peer?: PeerCommsPeer }
type PeerIndex = Map<string, PeerCommsPeer>

const GROUPS: ThreadGroup[] = ['agent', 'teammate', 'room']
const GROUP_LABEL = { agent: 'Agents', teammate: 'Teammates', room: 'Rooms' } as const
const PRESENCE: Record<PeerPresence, [dot: string, label: string]> = {
  online: ['bg-session-tone-active', 'Online'],
  busy: ['bg-status-warning', 'Busy'],
  away: ['bg-session-tone-waiting', 'Away'],
  offline: ['bg-muted-foreground/40', 'Offline']
}
const DELIVERY: Record<PeerDelivery, [icon: typeof Check, label: string, tone?: string]> = {
  sending: [Clock, 'Sending'],
  sent: [Check, 'Sent'],
  delivered: [CheckCheck, 'Delivered'],
  read: [CheckCheck, 'Read', 'text-status-info'],
  failed: [AlertCircle, 'Not delivered', 'text-destructive']
}
const AVATAR =
  'relative inline-flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold'
const AGENT_AVATAR =
  'bg-[color-mix(in_srgb,var(--ai-action-accent)_25%,var(--background))] text-foreground'
const HUMAN_AVATAR = 'bg-recipient-human text-recipient-human-foreground'
const AVATAR_DOT = 'absolute -right-0.5 -bottom-0.5 ring-2 ring-card'
const THREAD_ROW =
  'flex items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50'
const GROUP_HEADING =
  'px-2 pb-1 text-[11px] font-semibold tracking-[0.05em] text-muted-foreground uppercase'
const DOCK = 'flex h-full min-h-0 border border-border bg-card'
const MESSAGE_LIST = 'scrollbar-sleek flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3'
const THREAD_LABEL = 'min-w-0 flex-1 truncate'
const ROOM_ICON = 'size-4 shrink-0 text-muted-foreground'
const ROW = 'flex max-w-[85%] flex-col gap-0.5'
const BUBBLE = 'rounded-md px-2.5 py-1.5 text-sm break-words whitespace-pre-wrap'
const BUBBLE_OWN = 'bg-secondary text-secondary-foreground'
const BUBBLE_PEER = 'border border-border bg-background'

const t = (key: string, fallback: string, options?: Parameters<typeof translate>[2]): string =>
  translate(`peerComms.${key}`, fallback, options)
const presenceLabel = (p: PeerPresence): string => t(`presence.${p}`, PRESENCE[p][1])
const formatTime = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const unreadIds = (list: PeerCommsMessage[] | undefined, selfId: string): string[] =>
  (list ?? []).filter((m) => m.authorId !== selfId && m.delivery !== 'read').map((m) => m.id)

function optimisticMessage(input: PeerCommsSendInput, authorId: string): PeerCommsMessage {
  return { ...input, id: input.clientId, authorId, sentAt: Date.now(), delivery: 'sending' }
}

function groupByThread(messages: PeerCommsMessage[]): Map<string, PeerCommsMessage[]> {
  const byThread = new Map<string, PeerCommsMessage[]>()
  for (const message of [...messages].sort((a, b) => a.sentAt - b.sentAt)) {
    const list = byThread.get(message.threadId) ?? []
    list.push(message)
    byThread.set(message.threadId, list)
  }
  return byThread
}

function PresenceDot({ presence, className }: { presence: PeerPresence; className?: string }) {
  const label = presenceLabel(presence)
  const dot = cn('inline-block size-2 shrink-0 rounded-full', PRESENCE[presence][0], className)
  return <span role="img" aria-label={label} title={label} className={dot} />
}

function PeerAvatar({ peer }: { peer: PeerCommsPeer }) {
  const isAgent = peer.kind === 'agent'
  return (
    <span className={cn(AVATAR, isAgent ? AGENT_AVATAR : HUMAN_AVATAR)}>
      {isAgent ? <Bot className="size-3.5" aria-hidden /> : peer.name.slice(0, 1).toUpperCase()}
      <PresenceDot presence={peer.presence} className={AVATAR_DOT} />
    </span>
  )
}

function DeliveryReceipt({ message, onRetry }: { message: PeerCommsMessage; onRetry: () => void }) {
  const [Icon, fallback, tone] = DELIVERY[message.delivery]
  const label = t(`delivery.${message.delivery}`, fallback)
  const failed = message.delivery === 'failed'
  const seen = message.readBy?.length ?? 0
  return (
    <span title={label} className={cn('inline-flex items-center gap-1', tone)}>
      <Icon className="size-3" aria-hidden />
      <span className={failed ? undefined : 'sr-only'}>{label}</span>
      {seen > 0 ? t('seenBy', 'Seen by {{count}}', { count: seen }) : null}
      {failed ? (
        <Button variant="ghost" size="xs" onClick={onRetry}>
          <RotateCw aria-hidden />
          {t('retry', 'Retry')}
        </Button>
      ) : null}
    </span>
  )
}

type RowProps = { entry: ThreadEntry; unread: number; current: boolean; onSelect: () => void }
function ThreadRow({ entry, unread, current, onSelect }: RowProps) {
  return (
    <button
      type="button"
      data-current={current}
      aria-current={current ? 'true' : undefined}
      onClick={onSelect}
      className={cn(THREAD_ROW, current && 'bg-accent')}
    >
      {entry.peer ? <PeerAvatar peer={entry.peer} /> : <Hash className={ROOM_ICON} aria-hidden />}
      <span className={cn(THREAD_LABEL, unread > 0 && 'font-semibold')}>{entry.label}</span>
      {unread > 0 ? <Badge variant="secondary">{unread}</Badge> : null}
    </button>
  )
}

type MsgProps = { message: PeerCommsMessage; own: boolean; author?: string; onRetry: () => void }
function MessageRow({ message, own, author, onRetry }: MsgProps) {
  return (
    <div className={cn(ROW, own ? 'items-end self-end' : 'self-start')}>
      {author ? <span className="text-xs text-muted-foreground">{author}</span> : null}
      <div className={cn(BUBBLE, own ? BUBBLE_OWN : BUBBLE_PEER)}>{message.body}</div>
      <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        {formatTime(message.sentAt)}
        {own ? <DeliveryReceipt message={message} onRetry={onRetry} /> : null}
      </span>
    </div>
  )
}

function threadSubtitle(entry: ThreadEntry, rooms: PeerCommsRoom[], peerById: PeerIndex): string {
  const room = rooms.find((r) => roomThreadId(r.id) === entry.threadId)
  if (room) {
    const online = room.memberIds.filter((id) => peerById.get(id)?.presence === 'online').length
    const total = room.memberIds.length
    return t('roomPresence', '{{online}} of {{total}} online', { online, total })
  }
  const peer = entry.peer
  if (!peer || peer.presence === 'online' || !peer.lastSeenAt) {
    return peer ? presenceLabel(peer.presence) : ''
  }
  const time = formatTime(peer.lastSeenAt)
  return `${presenceLabel(peer.presence)} · ${t('lastSeen', 'last seen {{time}}', { time })}`
}

export function PeerCommsDock(props: PeerCommsDockProps) {
  const { selfId, peers, rooms, messages, onSend, onMarkRead, onClose, initialThreadId } = props
  const [pending, setPending] = useState<PeerCommsMessage[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [selectedThreadId, setSelectedThreadId] = useState(initialThreadId)
  const listRef = useRef<HTMLDivElement>(null)

  const peerById = useMemo<PeerIndex>(() => new Map(peers.map((p) => [p.id, p])), [peers])
  const threads = useMemo(() => {
    const dms = peers.filter((p) => p.id !== selfId)
    const entries: ThreadEntry[] = [
      ...dms.map((p) => ({ threadId: dmThreadId(p.id), label: p.name, group: p.kind, peer: p })),
      ...rooms.map((r) => ({ threadId: roomThreadId(r.id), label: r.name, group: 'room' as const }))
    ]
    return GROUPS.flatMap((group) => entries.filter((entry) => entry.group === group))
  }, [peers, rooms, selfId])

  const echoed = useMemo(() => new Set(messages.map((m) => m.clientId)), [messages])
  const messagesByThread = useMemo(
    () => groupByThread([...messages, ...pending.filter((m) => !echoed.has(m.clientId))]),
    [messages, pending, echoed]
  )

  // Fall back to the first thread when nothing is selected or the selected peer/room left.
  const active = threads.find((entry) => entry.threadId === selectedThreadId) ?? threads[0]
  const activeThreadId = active?.threadId ?? ''
  const activeMessages = messagesByThread.get(activeThreadId) ?? []
  const isRoom = active?.group === 'room'
  const authorOf = (id: string) => (isRoom ? (peerById.get(id)?.name ?? id) : undefined)
  const draft = drafts[activeThreadId] ?? ''
  const canSend = draft.trim() !== ''

  const unreadKey = unreadIds(activeMessages, selfId).join('\n')
  useEffect(() => {
    if (unreadKey) {
      onMarkRead?.(activeThreadId, unreadKey.split('\n'))
    }
  }, [unreadKey, activeThreadId, onMarkRead])

  useEffect(() => {
    const list = listRef.current
    if (list) {
      list.scrollTop = list.scrollHeight
    }
  }, [activeThreadId, activeMessages.length])

  const send = (threadId: string, body: string, retryClientId?: string): void => {
    const clientId = retryClientId ?? crypto.randomUUID()
    const input = { threadId, body: body.trim(), clientId }
    if (!input.body || !threadId) {
      return
    }
    // Drop the retried copy and anything the host already echoed so pending stays small.
    setPending((prev) => [
      ...prev.filter((m) => m.clientId !== clientId && !echoed.has(m.clientId)),
      optimisticMessage(input, selfId)
    ])
    const settle = (delivery: PeerDelivery) => () =>
      setPending((prev) => prev.map((m) => (m.clientId === clientId ? { ...m, delivery } : m)))
    Promise.resolve(input).then(onSend).then(settle('sent'), settle('failed'))
  }

  // Host-side failures resend under a new clientId so the old echo cannot hide the retry.
  const retry = (message: PeerCommsMessage): void => {
    const isOptimistic = pending.some((m) => m.id === message.id && m.clientId === message.clientId)
    send(message.threadId, message.body, isOptimistic ? message.clientId : undefined)
  }

  const submitDraft = (): void => {
    send(activeThreadId, draft)
    setDrafts((prev) => ({ ...prev, [activeThreadId]: '' }))
  }

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submitDraft()
    }
  }

  const placeholder =
    active?.peer?.presence === 'offline'
      ? t('offline', '{{name}} is offline; delivered when they return', { name: active?.label })
      : t('placeholder', 'Message {{name}}', { name: active?.label ?? '' })
  const title = active?.label ?? t('empty', 'No peers yet')
  const subtitle = active ? threadSubtitle(active, rooms, peerById) : ''
  const [closeLabel, sendLabel] = [t('close', 'Close'), t('send', 'Send')]

  return (
    <section aria-label={t('title', 'Peer comms')} className={cn(DOCK, props.className)}>
      <nav className="scrollbar-sleek flex w-44 shrink-0 flex-col gap-3 overflow-y-auto border-r border-border p-2">
        {GROUPS.map((group) => {
          const entries = threads.filter((entry) => entry.group === group)
          return entries.length === 0 ? null : (
            <div key={group} className="flex flex-col gap-0.5">
              <h3 className={GROUP_HEADING}>{t(`group.${group}`, GROUP_LABEL[group])}</h3>
              {entries.map((entry) => (
                <ThreadRow
                  key={entry.threadId}
                  entry={entry}
                  unread={unreadIds(messagesByThread.get(entry.threadId), selfId).length}
                  current={entry.threadId === activeThreadId}
                  onSelect={() => setSelectedThreadId(entry.threadId)}
                />
              ))}
            </div>
          )
        })}
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-border px-3 py-2">
          {active?.peer ? <PresenceDot presence={active.peer.presence} /> : null}
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-medium">{title}</span>
            <span className="truncate text-xs text-muted-foreground">{subtitle}</span>
          </div>
          {onClose ? (
            <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label={closeLabel}>
              <X />
            </Button>
          ) : null}
        </header>

        <div ref={listRef} role="log" aria-live="polite" className={MESSAGE_LIST}>
          {activeMessages.map((message) => (
            <MessageRow
              key={message.clientId ?? message.id}
              message={message}
              own={message.authorId === selfId}
              author={authorOf(message.authorId)}
              onRetry={() => retry(message)}
            />
          ))}
        </div>

        <footer className="flex items-end gap-2 border-t border-border p-2">
          <Textarea
            rows={2}
            value={draft}
            disabled={!active}
            onChange={(e) => setDrafts((prev) => ({ ...prev, [activeThreadId]: e.target.value }))}
            onKeyDown={onComposerKeyDown}
            placeholder={placeholder}
            aria-label={t('composer', 'Message')}
            className="min-h-0 resize-none"
          />
          <Button size="icon-sm" onClick={submitDraft} disabled={!canSend} aria-label={sendLabel}>
            <Send />
          </Button>
        </footer>
      </div>
    </section>
  )
}
