import { useCallback, useEffect, useRef, useState } from 'react'
import { Wrench } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { OmniRogueMcpApi, OmniSiMcpCatalogSearch } from '../../../../preload/api/omnirogue-api'
import { OmniSiMcpExplorerDrawer } from './OmniSiMcpExplorerDrawer'

const SEARCH_DEBOUNCE_MS = 200

type OmniSiMcpExplorerEntryProps = {
  /** Defaults to the preload OmniSI catalog search. */
  mcpApi?: OmniRogueMcpApi
}

/** Settings entry for the OmniSI MCP explorer; main lists and ranks the catalog (W5-41). */
export function OmniSiMcpExplorerEntry({ mcpApi }: OmniSiMcpExplorerEntryProps) {
  const [open, setOpen] = useState(false)
  const [result, setResult] = useState<OmniSiMcpCatalogSearch | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const query = useRef('')
  const sequence = useRef(0)
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(
    () => () => {
      clearTimeout(debounce.current)
      sequence.current++
    },
    []
  )

  const run = useCallback(
    async (refresh: boolean, showLoading: boolean) => {
      const api = mcpApi ?? window.api?.omnirogue?.mcp
      const id = ++sequence.current
      if (showLoading) {
        setLoading(true)
      }
      try {
        if (!api) {
          throw new Error(
            translate(
              'omniSiMcpExplorer.unavailable',
              'The OmniSI tool catalog is not available in this window.'
            )
          )
        }
        const next = await api.searchOmniSiTools({ query: query.current, refresh })
        if (id === sequence.current) {
          setResult(next)
          setError(null)
        }
      } catch (err) {
        if (id === sequence.current) {
          setError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        if (id === sequence.current) {
          setLoading(false)
        }
      }
    },
    [mcpApi]
  )

  const openExplorer = () => {
    setOpen(true)
    query.current = ''
    void run(false, true)
  }

  const search = (next: string) => {
    query.current = next
    clearTimeout(debounce.current)
    debounce.current = setTimeout(() => void run(false, false), SEARCH_DEBOUNCE_MS)
  }

  const changeOpen = (next: boolean) => {
    setOpen(next)
    if (!next) {
      clearTimeout(debounce.current)
      sequence.current++
      setLoading(false)
    }
  }

  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium">
          {translate('omniSiMcpExplorer.entryTitle', 'OmniSI tools')}
        </p>
        <p className="text-xs text-muted-foreground">
          {translate(
            'omniSiMcpExplorer.entryDescription',
            'Browse the tools, parameters and input schemas your OmniSI connection exposes to agents.'
          )}
        </p>
      </div>
      <Button type="button" variant="outline" size="sm" onClick={openExplorer}>
        <Wrench className="size-3.5" aria-hidden="true" />
        {translate('omniSiMcpExplorer.browse', 'Browse tools')}
      </Button>
      <OmniSiMcpExplorerDrawer
        open={open}
        onOpenChange={changeOpen}
        tools={result?.tools ?? []}
        totalCount={result?.total}
        loading={loading}
        error={error}
        onRefresh={() => void run(true, true)}
        onSearch={search}
      />
    </div>
  )
}
