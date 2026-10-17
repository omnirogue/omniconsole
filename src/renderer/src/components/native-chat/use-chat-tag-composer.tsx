import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject
} from 'react'
import { translate } from '@/i18n/i18n'
import { ChatRecipientPicker, type ChatTagOption } from './ChatRecipientPicker'
import { chatTagOptions } from './chat-tag-options'
import { ChatDeliveryBar } from './ChatDeliveryBar'
import { ChatDeliveryStatus } from './ChatDeliveryStatus'
import { Button } from '@/components/ui/button'
import { useChatTagDelivery } from './use-chat-tag-delivery'
import { applyMentionSuggestion, type ComposerAutocomplete } from './native-chat-composer-state'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import { formatNativeChatFileReference } from './native-chat-composer-target'

export function useChatTagComposer({
  paneKey,
  draft,
  caret,
  setDraft,
  setCaret,
  textareaRef,
  autocomplete,
  activeSuggestion,
  setActiveSuggestion,
  listboxId,
  onSent,
  onAttachUntagged,
  onRemoveImage,
  imageAttachments,
  referencedAttachments
}: {
  paneKey: string
  draft: string
  caret: number
  setDraft: (value: string) => void
  setCaret: (value: number) => void
  textareaRef: RefObject<HTMLTextAreaElement | null>
  autocomplete: ComposerAutocomplete
  activeSuggestion: number
  setActiveSuggestion: (value: number | ((current: number) => number)) => void
  listboxId: string
  onSent: () => void
  onAttachUntagged: (paths: string[]) => void
  imageAttachments: NativeChatComposerImageAttachment[]
  referencedAttachments: NativeChatComposerImageAttachment[]
  onRemoveImage: (id: string) => void
}) {
  const latestDraft = useRef(draft)
  useLayoutEffect(() => {
    latestDraft.current = draft
  }, [draft])
  const [dismissed, setDismissed] = useState('')
  const trigger = `${caret}:${draft}`
  const query = autocomplete.mode === 'mention' && trigger !== dismissed ? autocomplete.query : null
  const delivery = useChatTagDelivery({
    paneKey,
    draft,
    setDraft,
    setCaret,
    mentionQuery: query,
    onSent
  })
  const active = delivery.recipients.length > 0
  const imported = useRef(new Set<string>())
  const existingFiles = [
    ...imageAttachments,
    ...referencedAttachments.filter((file) =>
      draft.includes(formatNativeChatFileReference(file.path))
    )
  ]
  const uncaptured = existingFiles.filter(
    (file) =>
      !delivery.attachments.some(
        (item) => item.path === file.path && item.connectionId === file.connectionId
      )
  )
  useEffect(() => {
    if (!active || delivery.pending || delivery.attaching) {
      return
    }
    const file = uncaptured.find(
      (item) => !imported.current.has(`${item.connectionId ?? ''}:${item.path}`)
    )
    if (!file) {
      return
    }
    imported.current.add(`${file.connectionId ?? ''}:${file.path}`)
    void delivery.attach([file.path], file.connectionId)
  }, [active, delivery, uncaptured])
  const attach = (paths: string[]) =>
    active ? void delivery.attach(paths) : onAttachUntagged(paths)
  const removeAttachment = (path: string) => {
    delivery.removeAttachment(path)
    for (const image of imageAttachments.filter((image) => image.path === path)) {
      onRemoveImage(image.id)
    }
    setDraft(draft.replaceAll(formatNativeChatFileReference(path), ''))
  }
  const pickFile = async () => {
    const path = await window.api.shell.pickAttachment()
    if (path) {
      attach([path])
    }
  }
  const pickFolder = async () => {
    const path = await window.api.shell.pickDirectory({})
    if (path) {
      attach([path])
    }
  }
  const options = chatTagOptions(
    delivery.people.phase === 'ready' ? delivery.people.value : [],
    delivery.agents,
    query,
    active
  )
  const acceptMention = () => {
    if (autocomplete.mode !== 'mention') {
      return
    }
    const result = applyMentionSuggestion(draft, caret, autocomplete.query)
    setDraft(result.draft)
    setCaret(result.caret)
    const textarea = textareaRef.current
    textarea?.focus()
    requestAnimationFrame(() => textarea?.setSelectionRange(result.caret, result.caret))
  }
  const choose = async (option: ChatTagOption) => {
    if (delivery.pending || delivery.retrySaved || delivery.attaching) {
      return
    }
    if (option.kind === 'reference') {
      acceptMention()
      return
    }
    const path =
      option.kind === 'file'
        ? await window.api.shell.pickAttachment()
        : option.kind === 'folder'
          ? await window.api.shell.pickDirectory({})
          : null
    if (!option.recipient && !path) {
      return
    }
    if (latestDraft.current !== draft) {
      if (path) {
        attach([path])
      }
      return
    }
    const prefix = draft.slice(0, caret)
    const match = /(?:^|\s)@(\S*)$/.exec(prefix)
    if (match) {
      const start = caret - match[1].length - 1
      setDraft(draft.slice(0, start) + draft.slice(caret))
      setCaret(start)
      requestAnimationFrame(() => {
        textareaRef.current?.focus()
        textareaRef.current?.setSelectionRange(start, start)
      })
    }
    setActiveSuggestion(0)
    if (option.recipient) {
      delivery.choose(option.recipient)
    } else if (path) {
      attach([path])
    }
  }
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (query === null) {
      return false
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (options.length > 0) {
        setActiveSuggestion(
          (index) => (index + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length
        )
      }
      return true
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      if (options.length > 0) {
        void choose(options[activeSuggestion] ?? options[0])
      }
      return true
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setDismissed(trigger)
      return true
    }
    return false
  }
  return {
    tagging: query !== null,
    beginTag: () => {
      if (delivery.pending || delivery.retrySaved) {
        return
      }
      const text = `${draft.trimEnd()}${draft.trim() ? ' ' : ''}@`
      setDraft(text)
      setCaret(text.length)
      requestAnimationFrame(() => {
        textareaRef.current?.focus()
        textareaRef.current?.setSelectionRange(text.length, text.length)
      })
    },
    acceptMention,
    active,
    blocked: delivery.blocked,
    retrySaved: delivery.retrySaved,
    pending: delivery.pending,
    attaching: delivery.attaching || uncaptured.length > 0,
    attach,
    send: () => {
      if (!uncaptured.length) {
        return delivery.send()
      }
      return undefined
    },
    handleKeyDown,
    hasContent: draft.trim() !== '' || delivery.attachments.length > 0,
    sendLabel: active
      ? delivery.retrySaved
        ? translate('handoffs.retrySavedAction9b513', 'Retry saved action')
        : translate('chatDelivery.sendMessage', 'Send message')
      : undefined,
    optionCount: query !== null ? options.length : 0,
    picker:
      query !== null ? (
        <ChatRecipientPicker
          options={options}
          activeIndex={activeSuggestion}
          listboxId={listboxId}
          loading={delivery.people.phase === 'loading' || !delivery.agentsLoaded}
          error={delivery.people.phase === 'error' ? delivery.people.message : delivery.agentError}
          onChoose={(option) => void choose(option)}
        />
      ) : null,
    bar: active ? (
      <ChatDeliveryBar
        recipients={delivery.recipients}
        attachments={delivery.attachments}
        type={delivery.type}
        disabled={delivery.pending || delivery.retrySaved}
        attaching={delivery.attaching}
        onType={delivery.setType}
        onRemove={delivery.remove}
        onRemoveAttachment={removeAttachment}
        onFile={() => void pickFile()}
        onFolder={() => void pickFolder()}
      />
    ) : undefined,
    status: (
      <div className="space-y-2">
        {active && uncaptured.length > 0 && !delivery.attaching && (
          <Button
            size="sm"
            variant="outline"
            disabled={delivery.pending}
            onClick={() => {
              const file = uncaptured[0]
              if (file) {
                void delivery.attach([file.path], file.connectionId)
              }
            }}
          >
            {translate('chatDelivery.retryAttachment', 'Retry attaching file')}
          </Button>
        )}
        {delivery.history.length > 0 && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              {translate('chatDelivery.sentMessages', 'Sent messages')} ({delivery.history.length})
            </summary>
            <div className="max-h-96 space-y-2 scrollbar-sleek overflow-y-auto pt-2">
              {delivery.history.map((sent) => (
                <ChatDeliveryStatus
                  key={Object.values(sent.receipts)
                    .map((receipt) => receipt.id)
                    .join(':')}
                  scope={delivery.scope}
                  error=""
                  recipients={sent.recipients}
                  receipts={sent.receipts}
                  viewer={delivery.viewer}
                />
              ))}
            </div>
          </details>
        )}
        <ChatDeliveryStatus
          scope={delivery.scope}
          error={delivery.error}
          recipients={delivery.sentTo}
          receipts={delivery.receipts}
          viewer={delivery.viewer}
        />
      </div>
    )
  }
}
