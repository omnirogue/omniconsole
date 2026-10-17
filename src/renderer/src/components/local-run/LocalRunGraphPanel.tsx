import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { translate } from '@/i18n/i18n'
import type { LocalGraphView } from '@/lib/local-graph-view'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  LOCAL_RUN_RPC,
  isLocalRunActive,
  type LocalRunSnapshot
} from '../../../../shared/local-run-types'
import { LocalRunCanvas } from './LocalRunCanvas'
import { LocalRunNeedsInputCard } from './LocalRunNeedsInputCard'
import { LocalRunNodeDetail } from './LocalRunNodeDetail'
import { LocalRunTimeline } from './LocalRunTimeline'
import { LocalRunViewExport } from './LocalRunViewExport'
import { localGraphStageLabel } from './local-run-labels'

/**
 * One graph on the canvas: the deterministic layout, the step a person selected, the
 * timeline lanes, the exports, and — for a local Run — the answer form for whatever
 * step is waiting on them. Everything shown is a stored row; nothing is inferred.
 */
export function LocalRunGraphPanel({
  view,
  run,
  onRunChanged
}: {
  view: LocalGraphView
  /** The run behind this view, when it is a local Run rather than a Build + Review. */
  run?: LocalRunSnapshot | null
  onRunChanged?: (next: LocalRunSnapshot) => void
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const selected = view.nodes.find((node) => node.id === selectedId) ?? view.nodes[0] ?? null
  const cancel = async (): Promise<void> => {
    if (!run) {
      return
    }
    setCancelling(true)
    setError(null)
    try {
      const { run: next } = await callRuntimeRpc<{ run: LocalRunSnapshot }>(
        { kind: 'local' },
        LOCAL_RUN_RPC.cancel,
        { id: run.id }
      )
      onRunChanged?.(next)
    } catch (failure) {
      setError(String(failure))
    } finally {
      setCancelling(false)
    }
  }
  return (
    <section className="min-w-0 space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate font-mono text-sm">{view.id}</h2>
          <p className="truncate text-xs text-muted-foreground" title={view.workspacePath}>
            {translate('auto.components.local-run.Panel.workspace', 'Workspace')}:{' '}
            {view.workspacePath}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{localGraphStageLabel(view.stage)}</span>
          {run && isLocalRunActive(run.stage) && (
            <Button size="sm" variant="outline" disabled={cancelling} onClick={() => void cancel()}>
              {translate('auto.components.local-run.Panel.cancel', 'Stop this run')}
            </Button>
          )}
        </div>
      </header>
      {view.error && (
        <p role="alert" className="whitespace-pre-wrap break-words text-sm text-destructive">
          {view.error}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {run && <LocalRunNeedsInputCard run={run} onAnswered={onRunChanged} />}
      <Tabs defaultValue="graph" className="space-y-3">
        <TabsList>
          <TabsTrigger value="graph">
            {translate('auto.components.local-run.Panel.graphTab', 'Graph')}
          </TabsTrigger>
          <TabsTrigger value="timeline">
            {translate('auto.components.local-run.Panel.timelineTab', 'Timeline')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="graph" className="space-y-4">
          <LocalRunCanvas
            view={view}
            selectedId={selected?.id ?? null}
            onSelect={(id) => setSelectedId(id)}
          />
          {selected && <LocalRunNodeDetail key={selected.id} view={view} node={selected} />}
        </TabsContent>
        <TabsContent value="timeline">
          <LocalRunTimeline view={view} />
        </TabsContent>
      </Tabs>
      <LocalRunViewExport view={view} />
    </section>
  )
}
