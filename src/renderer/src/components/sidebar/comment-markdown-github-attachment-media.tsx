import React from 'react'
import { useLocalImageSrc } from '@/components/editor/useLocalImageSrc'
import { fileUriToFilesystemPath } from '../../../../shared/file-uri-path'
import { ExpandableMarkdownImage } from './MarkdownImageLightbox'

const DIRECT_VIDEO_EXT_RE = /\.(?:mp4|webm|mov)(?:[?#].*)?$/i
const DIRECT_AUDIO_EXT_RE = /\.(?:mp3|wav|m4a|ogg)(?:[?#].*)?$/i

export function isDirectVideoLink(href: string | undefined): href is string {
  if (!href) {
    return false
  }
  return DIRECT_VIDEO_EXT_RE.test(href.trim())
}

export function isDirectAudioLink(href: string | undefined): href is string {
  if (!href) {
    return false
  }
  return DIRECT_AUDIO_EXT_RE.test(href.trim())
}

function toLocalFilesystemPath(rawUrl: string | undefined): string | null {
  if (!rawUrl) {
    return null
  }
  const trimmed = rawUrl.trim()
  if (trimmed.startsWith('/')) {
    return trimmed
  }
  if (trimmed.toLowerCase().startsWith('file:')) {
    try {
      return fileUriToFilesystemPath(new URL(trimmed))
    } catch {
      return null
    }
  }
  return null
}

function useLocalMediaSrc(
  rawSrc: string | undefined,
  allowLocalFiles: boolean
): string | undefined {
  const detectedLocalPath = toLocalFilesystemPath(rawSrc)
  const localPath = allowLocalFiles ? detectedLocalPath : null
  const resolvedLocalSrc = useLocalImageSrc(localPath ?? undefined, localPath ?? '/')
  if (detectedLocalPath !== null) {
    return allowLocalFiles ? resolvedLocalSrc : undefined
  }
  return rawSrc
}

export function isGitHubUserAttachmentUrl(href: string | undefined): href is string {
  if (!href) {
    return false
  }
  try {
    const url = new URL(href)
    return (
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      url.pathname.startsWith('/user-attachments/assets/')
    )
  } catch {
    return false
  }
}

function isBareAutolink(children: React.ReactNode, href: string): boolean {
  const text = React.Children.toArray(children).join('').trim()
  return text === href
}

export function isGitHubUserAttachmentVideoLink(
  href: string | undefined,
  children: React.ReactNode
): href is string {
  return isGitHubUserAttachmentUrl(href) && isBareAutolink(children, href)
}

// Shared fallback link for attachments that can't render inline (see the image
// note below on why load failures drop to a session-scoped link).
function AttachmentFallbackLink({
  href,
  children
}: {
  href: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="break-all text-primary underline underline-offset-2 hover:text-primary/80"
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </a>
  )
}

export function GitHubUserAttachmentVideo({
  href,
  children
}: {
  href: string
  children: React.ReactNode
}): React.ReactElement {
  const [failed, setFailed] = React.useState(false)

  if (failed || !href || toLocalFilesystemPath(href) !== null) {
    return <AttachmentFallbackLink href={href}>{children}</AttachmentFallbackLink>
  }

  return (
    <video
      src={href}
      controls
      preload="metadata"
      playsInline
      className="my-3 max-h-[28rem] max-w-full rounded-md bg-black/80 outline outline-1 outline-black/10 dark:outline-white/10"
      onClick={(e) => e.stopPropagation()}
      onError={() => setFailed(true)}
    >
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    </video>
  )
}

export function DirectMediaAudio({
  href,
  children
}: {
  href: string
  children: React.ReactNode
}): React.ReactElement {
  const [failed, setFailed] = React.useState(false)

  if (failed || !href || toLocalFilesystemPath(href) !== null) {
    return <AttachmentFallbackLink href={href}>{children}</AttachmentFallbackLink>
  }

  return (
    <audio
      src={href}
      controls
      preload="metadata"
      className="my-2 block w-full max-w-md"
      onClick={(e) => e.stopPropagation()}
      onError={() => setFailed(true)}
    >
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    </audio>
  )
}

export function DocumentMarkdownImage({
  src,
  alt,
  allowLocalFiles = false,
  onImageClick
}: {
  src: string
  alt: string | undefined
  allowLocalFiles?: boolean
  onImageClick?: (event: React.MouseEvent<HTMLElement>) => void
}): React.ReactElement {
  const mediaSrc = useLocalMediaSrc(src, allowLocalFiles)
  if (!mediaSrc) {
    return <span className="text-xs text-muted-foreground">{alt || src}</span>
  }
  return (
    <ExpandableMarkdownImage
      src={mediaSrc}
      alt={alt}
      onImageClick={onImageClick}
      className="max-h-96 max-w-full rounded-md object-contain outline outline-1 outline-black/10 dark:outline-white/10"
    />
  )
}

export function GitHubUserAttachmentImage({
  src,
  alt
}: {
  src: string
  alt: string | undefined
}): React.ReactElement {
  const [failed, setFailed] = React.useState(false)
  const label = alt?.trim() || src

  // Why: private-repo attachment images can't load cross-origin without the
  // user's GitHub session cookies, so wrap in a top-level link (opening the
  // URL where that session exists) and drop to a text link on load error.
  if (failed) {
    return <AttachmentFallbackLink href={src}>{label}</AttachmentFallbackLink>
  }

  return (
    <a
      href={src}
      target="_blank"
      rel="noreferrer"
      className="inline-block max-w-full"
      onClick={(e) => e.stopPropagation()}
    >
      <img
        src={src}
        alt={alt ?? ''}
        className="my-3 max-h-96 max-w-full rounded-md object-contain outline outline-1 outline-black/10 dark:outline-white/10"
        onError={() => setFailed(true)}
      />
    </a>
  )
}
