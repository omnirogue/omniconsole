import { useEffect, useState } from 'react'
import { AlertCircle, ExternalLink, Loader2 } from 'lucide-react'
import type { SliteDocResult } from '../../../../../shared/slite-doc'
import { Button } from '@/components/ui/button'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { translate } from '@/i18n/i18n'
import { fetchSliteDoc } from './session-artifact-client'

/** How often a visible Slite doc is re-read, so a plan's ticks and edits show as they happen. */
const SLITE_DOC_REFRESH_MS = 30_000

// Why module-wide: the picker names a doc by its title, which only this view has read.
const titles = new Map<string, string>()

export function sliteDocTitle(id: string): string | null {
  return titles.get(id) ?? null
}

function openExternal(href: string | undefined): void {
  if (href && /^https?:\/\//i.test(href)) {
    void window.api.shell.openUrl(href)
  }
}

function useSliteDoc(id: string, visible: boolean): SliteDocResult | null {
  const [result, setResult] = useState<SliteDocResult | null>(null)
  useEffect(() => {
    if (!visible) {
      return
    }
    let disposed = false
    const refresh = (): void => {
      if (document.visibilityState === 'hidden') {
        return
      }
      fetchSliteDoc(id).then(
        (next) => {
          if (disposed) {
            return
          }
          if (next.status === 'ok') {
            titles.set(id, next.title)
          }
          // Why keep a shown doc on a failed re-read: a blip must not blank a plan being read.
          setResult((current) =>
            next.status !== 'ok' && current?.status === 'ok' ? current : next
          )
        },
        () => {
          if (!disposed) {
            setResult(
              (current) =>
                current ?? {
                  status: 'error',
                  message: translate(
                    'auto.components.sessionArtifact.sliteUnavailable',
                    'This Slite doc could not be read.'
                  )
                }
            )
          }
        }
      )
    }
    refresh()
    const interval = setInterval(refresh, SLITE_DOC_REFRESH_MS)
    return () => {
      disposed = true
      clearInterval(interval)
    }
  }, [id, visible])
  return result
}

/**
 * A Slite doc the conversation linked (a plan, a report), shown in place so a person can click
 * through sessions and see what each is working on. Edits and ticks happen in Slite.
 */
export function SessionSliteDoc({
  id,
  url,
  visible,
  picker
}: {
  id: string
  url: string
  visible: boolean
  picker: React.ReactNode
}): React.JSX.Element {
  const result = useSliteDoc(id, visible)
  const title =
    result?.status === 'ok'
      ? result.title
      : translate('auto.components.sessionArtifact.sliteDoc', 'Slite doc')
  const updatedAt = result?.status === 'ok' && result.updatedAt ? new Date(result.updatedAt) : null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-1.5 border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-xs font-medium" title={title}>
            {title}
          </p>
          {updatedAt && !Number.isNaN(updatedAt.getTime()) ? (
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {updatedAt.toLocaleString(undefined, {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit'
              })}
            </span>
          ) : null}
          <span className="shrink-0 rounded-full border border-border px-1.5 py-px text-[10px] font-medium text-muted-foreground">
            {translate('auto.components.sessionArtifact.sliteBadge', 'Slite')}
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          {picker ? <div className="min-w-0 flex-1">{picker}</div> : <div className="flex-1" />}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 shrink-0 gap-1.5 text-xs"
            onClick={() => openExternal(url)}
          >
            <ExternalLink className="size-3.5" />
            {translate('auto.components.sessionArtifact.openInSlite', 'Open in Slite')}
          </Button>
        </div>
      </div>
      {result === null ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : result.status === 'ok' ? (
        <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto px-4 py-3 text-sm">
          <CommentMarkdown
            variant="document"
            content={result.markdown}
            onLinkClick={(event, href) => {
              event.preventDefault()
              openExternal(href)
            }}
          />
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <AlertCircle className="size-6 text-muted-foreground" />
          <p className="max-w-sm text-xs text-muted-foreground">{result.message}</p>
        </div>
      )}
    </div>
  )
}
