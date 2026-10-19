import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, Image as ImageIcon, Square, Volume2 } from 'lucide-react'
import { ExpandableMarkdownImage } from '@/components/sidebar/MarkdownImageLightbox'
import { useLocalImageSrc } from '@/components/editor/useLocalImageSrc'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { basename } from '@/lib/path'
import type { NativeChatBlock } from '../../../../shared/native-chat-types'
import { isNativeChatPastedImagePath } from './native-chat-image-paste'
import { NativeChatCopyButton } from './NativeChatCopyButton'

type NativeChatImageRefBlock = Extract<NativeChatBlock, { type: 'image-ref' }>

let activeSpeechUtterance: SpeechSynthesisUtterance | null = null
let stopActiveSpeechRow: (() => void) | null = null

function NativeChatImageAttachmentCard({
  image
}: {
  image: NativeChatImageRefBlock
}): React.JSX.Element {
  const label = image.alt ?? image.path ?? image.url ?? 'Image'
  const name =
    image.path && isNativeChatPastedImagePath(image.path)
      ? translate('components.native-chat.composer.pastedImageLabel', 'Pasted image')
      : image.path
        ? basename(image.path)
        : label

  const filePath = image.path?.trim() || undefined
  const localSrc = useLocalImageSrc(filePath, filePath ?? '/')
  const resolvedSrc = localSrc ?? image.url ?? null

  return (
    <div
      className="flex max-w-full flex-col gap-1.5 rounded-md border border-border bg-background p-1.5 text-xs text-muted-foreground"
      title={label}
    >
      {resolvedSrc ? (
        <ExpandableMarkdownImage
          src={resolvedSrc}
          alt={name}
          triggerClassName="my-0 block overflow-hidden rounded"
          className="max-h-32 max-w-52 rounded object-cover outline outline-1 outline-border/60"
        />
      ) : null}
      <div className="flex items-center gap-1.5 px-0.5">
        <ImageIcon className="size-3.5 shrink-0" />
        <span className="truncate">{name}</span>
      </div>
    </div>
  )
}

export function NativeChatImageAttachments({
  blocks
}: {
  blocks: NativeChatBlock[]
}): React.JSX.Element | null {
  const images = blocks.filter(
    (block): block is NativeChatImageRefBlock => block.type === 'image-ref'
  )
  if (images.length === 0) {
    return null
  }
  return (
    <div className="mb-2 flex flex-wrap gap-2">
      {images.map((image, index) => {
        const label = image.alt ?? image.path ?? image.url ?? 'Image'
        return <NativeChatImageAttachmentCard key={`${label}-${index}`} image={image} />
      })}
    </div>
  )
}

export function NativeChatAgentControls({
  markdown,
  onScrollToTop,
  className
}: {
  markdown: string
  onScrollToTop: () => void
  className?: string
}): React.JSX.Element {
  const [speaking, setSpeaking] = useState(false)
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null)

  useEffect(() => {
    return () => {
      const ownUtterance = utteranceRef.current
      if (ownUtterance && activeSpeechUtterance === ownUtterance) {
        activeSpeechUtterance = null
        stopActiveSpeechRow = null
        if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
          window.speechSynthesis.cancel()
        }
      }
      utteranceRef.current = null
    }
  }, [])

  const toggleReadAloud = useCallback(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      return
    }
    if (speaking) {
      if (activeSpeechUtterance === utteranceRef.current) {
        activeSpeechUtterance = null
        stopActiveSpeechRow = null
      }
      utteranceRef.current = null
      window.speechSynthesis.cancel()
      setSpeaking(false)
      return
    }
    const plainText = markdown
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[#>*_~-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!plainText) {
      return
    }
    stopActiveSpeechRow?.()
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(plainText)
    utteranceRef.current = utterance
    activeSpeechUtterance = utterance
    stopActiveSpeechRow = () => {
      if (utteranceRef.current === utterance) {
        utteranceRef.current = null
      }
      setSpeaking(false)
    }
    const finishIfCurrent = () => {
      if (utteranceRef.current === utterance) {
        utteranceRef.current = null
        if (activeSpeechUtterance === utterance) {
          activeSpeechUtterance = null
          stopActiveSpeechRow = null
        }
        setSpeaking(false)
      }
    }
    utterance.onend = finishIfCurrent
    utterance.onerror = finishIfCurrent
    setSpeaking(true)
    window.speechSynthesis.speak(utterance)
  }, [markdown, speaking])

  return (
    <div className={cn('flex items-center gap-1', className)}>
      <NativeChatCopyButton text={markdown} />
      <button
        type="button"
        onClick={toggleReadAloud}
        aria-label={
          speaking
            ? translate('components.native-chat.stopReadAloud', 'Stop reading aloud')
            : translate('components.native-chat.readAloud', 'Read message aloud')
        }
        title={
          speaking
            ? translate('components.native-chat.stopReadAloud', 'Stop reading aloud')
            : translate('components.native-chat.readAloud', 'Read message aloud')
        }
        className={cn(
          'flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          speaking && 'bg-accent text-foreground'
        )}
      >
        {speaking ? <Square className="size-3" /> : <Volume2 className="size-3.5" />}
      </button>
      <button
        type="button"
        onClick={onScrollToTop}
        aria-label={translate(
          'components.native-chat.scrollMessageToTop',
          'Scroll this message to top'
        )}
        title={translate('components.native-chat.scrollMessageToTop', 'Scroll this message to top')}
        className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowUp className="size-3.5" />
      </button>
    </div>
  )
}

export function ProviderFrameRow({ block }: { block: NativeChatBlock }): React.JSX.Element | null {
  if (block.type !== 'text' || !block.providerFrame) {
    return null
  }
  const frame = block.providerFrame
  return (
    <div>
      {block.text !== `${frame.provider} · ${frame.kind}` ? (
        <p className="text-sm">{block.text}</p>
      ) : null}
      <details className="group text-xs text-muted-foreground">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1 font-mono hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span className="transition-transform group-open:rotate-90">›</span>
          <span>{translate('chatActions.technicalDetails', 'View technical details')}</span>
        </summary>
        <p>
          {frame.provider} · {frame.kind} ·{' '}
          {translate('components.native-chat.providerFrame.byteLength', '{{value0}} bytes', {
            value0: frame.payload.byteLength
          })}
        </p>
        <pre className="scrollbar-sleek mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted p-2 font-mono text-xs text-foreground">
          {frame.payload.head}
          {frame.payload.truncated ? '\n…' : ''}
        </pre>
      </details>
    </div>
  )
}

export function TypingIndicatorRow({ label }: { label: string }): React.JSX.Element {
  return (
    <div
      className="flex items-center justify-start"
      aria-label={translate('components.native-chat.status.responding', 'Agent is responding')}
      aria-live="polite"
    >
      <div className="flex h-8 items-center gap-1.5 text-status-info">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="size-1.5 motion-safe:animate-bounce rounded-full bg-status-info"
            style={{ animationDelay: `${i * 160}ms` }}
          />
        ))}
        <span className="ml-1 text-xs">{label}</span>
      </div>
    </div>
  )
}
