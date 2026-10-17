import { useEffect, useRef, useState } from 'react'
import { Check, FileText, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { translate } from '@/i18n/i18n'
import {
  searchContextDocuments,
  resolveContextDocument
} from '@/lib/session-context-document-client'
import type { SessionContextAttachment } from '../../../../shared/session-context-attachments'
import type { ContextDocument } from '../../../../shared/session-context-documents'
import { SESSION_CONTEXT_DOCUMENT_QUERY_MAX_CHARS } from '../../../../shared/session-context-documents'

type Source = 'slite' | 'omnios'
type SearchPage = { source: Source; documents: ContextDocument[]; cursor?: string; error?: string }

export function SessionContextDocuments({
  chosen,
  busy,
  onAdd,
  onError
}: {
  chosen: ReadonlySet<string>
  busy: boolean
  onAdd: (items: SessionContextAttachment[]) => Promise<void>
  onError: (message: string) => void
}) {
  const [query, setQuery] = useState('')
  const [pages, setPages] = useState<SearchPage[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const generation = useRef(0)
  useEffect(() => {
    let cancelled = false
    generation.current += 1
    setLoading(true)
    setPages([])
    const timer = setTimeout(() => {
      void Promise.all(
        (['omnios', 'slite'] as const).map(async (source): Promise<SearchPage> => {
          try {
            const result = await searchContextDocuments({ source, query })
            return result.status === 'ok'
              ? { source, documents: result.documents, cursor: result.nextCursor }
              : { source, documents: [], error: result.message }
          } catch {
            return {
              source,
              documents: [],
              error: translate('sessionContext.searchFailed', 'Search could not be completed.')
            }
          }
        })
      ).then((next) => {
        if (!cancelled) {
          setPages(next)
          setLoading(false)
        }
      })
    }, 250)
    return () => {
      cancelled = true
      generation.current += 1
      clearTimeout(timer)
    }
  }, [query, retry])

  const add = async (document: ContextDocument) => {
    if (adding || busy) {
      return
    }
    const id = `${document.source}:${document.id}`
    if (chosen.has(id)) {
      return
    }
    setAdding(id)
    try {
      const result = await resolveContextDocument({ source: document.source, id: document.id })
      if (result.status !== 'ok') {
        throw new Error(result.message)
      }
      const snapshot = result.document
      await onAdd([
        {
          id,
          kind: snapshot.source,
          title: snapshot.title,
          uri: snapshot.url,
          content: snapshot.content,
          capturedAt: snapshot.capturedAt,
          truncated: snapshot.truncated
        }
      ])
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setAdding(null)
    }
  }

  const more = async (page: SearchPage) => {
    if (!page.cursor || loading) {
      return
    }
    const startedAt = generation.current
    setLoading(true)
    const result = await searchContextDocuments({
      source: page.source,
      query,
      cursor: page.cursor
    }).catch(() => ({
      status: 'error' as const,
      message: translate('sessionContext.searchFailed', 'Search could not be completed.')
    }))
    if (startedAt !== generation.current) {
      return
    }
    setPages((current) =>
      current.map((entry) =>
        entry !== page
          ? entry
          : result.status === 'ok'
            ? {
                ...page,
                documents: [
                  ...page.documents,
                  ...result.documents.filter(
                    (doc) => !page.documents.some((old) => old.id === doc.id)
                  )
                ],
                cursor: result.nextCursor
              }
            : { ...page, error: result.message }
      )
    )
    setLoading(false)
  }

  return (
    <Command shouldFilter={false} className="h-auto border">
      <CommandInput
        maxLength={SESSION_CONTEXT_DOCUMENT_QUERY_MAX_CHARS}
        value={query}
        onValueChange={setQuery}
        aria-label={translate(
          'sessionContext.searchDocuments',
          'Search OmniOS artifacts and Slite documents'
        )}
        placeholder={translate(
          'sessionContext.searchDocumentsPlaceholder',
          'Search OmniOS and Slite, or paste a link…'
        )}
      />
      <CommandList className="max-h-56">
        {loading && (
          <p
            role="status"
            className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground"
          >
            <Loader2 className="size-3 animate-spin" />
            {translate('sessionContext.searching', 'Searching…')}
          </p>
        )}
        {pages.map((page) => (
          <CommandGroup key={page.source} heading={page.source === 'slite' ? 'Slite' : 'OmniOS'}>
            {page.documents.map((document) => {
              const id = `${document.source}:${document.id}`
              const Icon = chosen.has(id) ? Check : adding === id ? Loader2 : FileText
              return (
                <CommandItem
                  key={id}
                  value={id}
                  disabled={busy || adding !== null || chosen.has(id)}
                  onSelect={() => void add(document)}
                >
                  <Icon className={adding === id ? 'size-3.5 animate-spin' : 'size-3.5'} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{document.title}</span>
                    {document.preview && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {document.preview}
                      </span>
                    )}
                  </span>
                  {chosen.has(id) && (
                    <span className="text-xs text-muted-foreground">
                      {translate('sessionContext.added', 'Added')}
                    </span>
                  )}
                </CommandItem>
              )
            })}
            {page.error ? (
              <div className="px-2 py-1 text-xs">
                <p role="alert" className="text-destructive">
                  {page.error}
                </p>
                <Button size="xs" variant="link" onClick={() => setRetry((value) => value + 1)}>
                  {translate('sessionContext.retry', 'Retry')}
                </Button>
              </div>
            ) : !page.documents.length && !loading ? (
              <p className="px-2 py-1 text-xs text-muted-foreground">
                {page.cursor
                  ? translate(
                      'sessionContext.moreToSearch',
                      'No matches in these pages. Load more to search older documents.'
                    )
                  : translate('sessionContext.noDocuments', 'No documents found.')}
              </p>
            ) : null}
            {page.cursor && (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={loading}
                onClick={() => void more(page)}
              >
                {translate('sessionContext.more', 'Load more')}
              </Button>
            )}
          </CommandGroup>
        ))}
      </CommandList>
    </Command>
  )
}
