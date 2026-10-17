import { useEffect, useState } from 'react'
import Markdown from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import { translate } from '@/i18n/i18n'
import type { HandoffDetail } from '../../../../shared/console-handoff-contract'
import { readHandoffVersionText } from './handoff-client'

export const PREVIEW_MAX_BYTES = 512 * 1024
const MARKDOWN = /\.(md|markdown|mdx)$/i
const TEXT = /\.(txt|log|json|ya?ml|toml|csv|diff|patch|sh|py|ts|tsx|js|mjs|cjs|sql|html|css)$/i

/** Can this handoff file be shown inline (markdown rendered, other text verbatim)? */
export function previewKind(name: string): 'markdown' | 'text' | null {
  if (MARKDOWN.test(name)) {
    return 'markdown'
  }
  return TEXT.test(name) ? 'text' : null
}

/** Inline preview of one handoff file version: markdown rendered, plain text verbatim. */
export function HandoffFilePreview({
  threadId,
  file
}: {
  threadId: string
  file: HandoffDetail['files'][number]
}) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState('')
  const kind = previewKind(file.name)
  useEffect(() => {
    let live = true
    setText(null)
    setError('')
    if (!kind || file.size > PREVIEW_MAX_BYTES) {
      return
    }
    void readHandoffVersionText(threadId, file).then(
      (value) => {
        if (live) {
          setText(value)
        }
      },
      (reason) => {
        if (live) {
          setError(String(reason instanceof Error ? reason.message : reason))
        }
      }
    )
    return () => {
      live = false
    }
  }, [threadId, file, kind])
  if (!kind) {
    return (
      <p className="p-3 text-xs text-muted-foreground">
        {translate(
          'handoffs.previewUnsupported',
          'No inline preview for this file type; download it instead.'
        )}
      </p>
    )
  }
  if (file.size > PREVIEW_MAX_BYTES) {
    return (
      <p className="p-3 text-xs text-muted-foreground">
        {translate('handoffs.previewTooLarge', 'Too large to preview inline; download it instead.')}
      </p>
    )
  }
  if (error) {
    return (
      <p role="alert" className="p-3 text-xs text-destructive">
        {error}
      </p>
    )
  }
  if (text === null) {
    return (
      <p className="p-3 text-xs text-muted-foreground">
        {translate('handoffs.previewLoading', 'Loading preview…')}
      </p>
    )
  }
  if (kind === 'text') {
    return (
      <pre className="scrollbar-sleek max-h-[60vh] overflow-auto whitespace-pre-wrap break-words p-3 text-xs">
        {text}
      </pre>
    )
  }
  return (
    <div
      data-testid="handoff-markdown-preview"
      className="markdown-preview-body scrollbar-sleek max-h-[60vh] overflow-auto px-4 py-3 text-sm"
    >
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
        {text}
      </Markdown>
    </div>
  )
}
