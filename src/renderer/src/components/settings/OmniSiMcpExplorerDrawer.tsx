import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet'
import {
  filterOmniSiMcpTools,
  formatOmniSiMcpSchema,
  getOmniSiMcpParameters,
  omniSiMcpExplorerLabels,
  type OmniSiMcpExplorerLabels,
  type OmniSiMcpTool
} from './omnisi-mcp-explorer-helpers'

export type OmniSiMcpExplorerDrawerProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  tools: readonly OmniSiMcpTool[]
  loading?: boolean
  error?: string | null
  // The caller owns discovery and refresh state, including failures.
  onRefresh?: () => void
  // When set, the caller ranks `tools` for each query and `totalCount` is the full catalog size.
  onSearch?: (query: string) => void
  totalCount?: number
  labels?: Partial<OmniSiMcpExplorerLabels>
}

function ToolDetails({
  tool,
  labels
}: {
  tool: OmniSiMcpTool
  labels: OmniSiMcpExplorerLabels
}): React.JSX.Element {
  const parameters = getOmniSiMcpParameters(tool.inputSchema)
  const schema = formatOmniSiMcpSchema(tool.inputSchema)
  return (
    <section aria-label={labels.details} className="min-w-0 space-y-4">
      <div className="space-y-1">
        <h3 className="break-words text-sm font-semibold">{tool.title || tool.name}</h3>
        {tool.title && <p className="break-all font-mono text-xs">{tool.name}</p>}
        <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
          {tool.description || labels.noDescription}
        </p>
      </div>
      <div className="space-y-2">
        <h4 className="text-sm font-medium">{labels.parameters}</h4>
        {parameters.length === 0 ? (
          <p className="text-xs text-muted-foreground">{labels.noParameters}</p>
        ) : (
          <dl className="divide-y divide-border rounded-md border border-border px-3">
            {parameters.map((parameter) => (
              <div key={parameter.name} className="space-y-1 py-3">
                <dt className="flex flex-wrap items-center gap-2">
                  <span className="break-all font-mono text-xs">{parameter.name}</span>
                  <Badge variant="outline">
                    {parameter.required ? labels.required : labels.optional}
                  </Badge>
                </dt>
                <dd className="space-y-1 text-xs text-muted-foreground">
                  <p className="break-words font-mono">{parameter.type || labels.unknownType}</p>
                  {parameter.description && (
                    <p className="whitespace-pre-wrap break-words">{parameter.description}</p>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      <details className="rounded-md border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium">{labels.inputSchema}</summary>
        <pre className="mt-3 whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground">
          {schema ?? labels.schemaUnavailable}
        </pre>
      </details>
    </section>
  )
}

function ExplorerContents({
  tools,
  loading,
  error,
  onRefresh,
  onSearch,
  totalCount,
  labels
}: Pick<
  OmniSiMcpExplorerDrawerProps,
  'tools' | 'loading' | 'error' | 'onRefresh' | 'onSearch' | 'totalCount'
> & {
  labels: OmniSiMcpExplorerLabels
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const filtered = onSearch ? tools : filterOmniSiMcpTools(tools, query)
  const total = totalCount ?? tools.length
  const changeQuery = (next: string) => {
    setQuery(next)
    onSearch?.(next)
  }
  const selected = filtered.find((tool) => tool.name === selectedName) ?? filtered[0]
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 px-4 pb-4" aria-busy={loading}>
      <div className="flex items-center gap-2">
        <Input
          type="search"
          aria-label={labels.search}
          placeholder={labels.searchPlaceholder}
          value={query}
          onChange={(event) => changeQuery(event.target.value)}
        />
        {onRefresh && (
          <Button type="button" variant="outline" size="sm" disabled={loading} onClick={onRefresh}>
            {labels.refresh}
          </Button>
        )}
      </div>
      {loading ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {labels.loading}
        </p>
      ) : error != null ? (
        <div role="alert" className="space-y-1 text-sm text-destructive">
          <p>{labels.loadError}</p>
          {error && <p className="whitespace-pre-wrap break-words">{error}</p>}
        </div>
      ) : (
        <>
          <p role="status" className="text-xs text-muted-foreground">
            {labels.toolCount(filtered.length, total)}
          </p>
          {filtered.length === 0 ? (
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>{total === 0 ? labels.empty : labels.noMatches}</p>
              {query && (
                <Button type="button" variant="ghost" size="sm" onClick={() => changeQuery('')}>
                  {labels.clearSearch}
                </Button>
              )}
            </div>
          ) : (
            <div className="scrollbar-sleek grid min-h-0 gap-4 overflow-y-auto sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
              <div role="group" aria-label={labels.tools} className="min-w-0 space-y-1">
                {filtered.map((tool) => (
                  <Button
                    key={tool.name}
                    type="button"
                    variant={selected?.name === tool.name ? 'secondary' : 'ghost'}
                    className="h-auto w-full justify-start whitespace-normal break-all px-2 py-2 text-left font-mono text-xs"
                    aria-pressed={selected?.name === tool.name}
                    onClick={() => setSelectedName(tool.name)}
                  >
                    {tool.name}
                  </Button>
                ))}
              </div>
              {selected && <ToolDetails tool={selected} labels={labels} />}
            </div>
          )}
        </>
      )}
    </div>
  )
}

export function OmniSiMcpExplorerDrawer({
  open,
  onOpenChange,
  labels: labelOverrides,
  ...props
}: OmniSiMcpExplorerDrawerProps): React.JSX.Element {
  const labels = { ...omniSiMcpExplorerLabels, ...labelOverrides }
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" showCloseButton={false} className="w-full sm:max-w-3xl">
        <SheetHeader>
          <div className="flex items-center justify-between gap-3">
            <SheetTitle>{labels.title}</SheetTitle>
            <SheetClose asChild>
              <Button type="button" variant="ghost" size="sm">
                {labels.close}
              </Button>
            </SheetClose>
          </div>
          <SheetDescription>{labels.description}</SheetDescription>
        </SheetHeader>
        {open && <ExplorerContents {...props} labels={labels} />}
      </SheetContent>
    </Sheet>
  )
}
