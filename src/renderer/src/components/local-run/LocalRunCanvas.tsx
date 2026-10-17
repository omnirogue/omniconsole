import { useId } from 'react'
import { Folder, GitBranch, Repeat, Server } from 'lucide-react'
import { AgentStateDot } from '@/components/AgentStateDot'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { layoutConsoleWorkflow } from '@/lib/console-workflow-layout'
import type { LocalGraphNode, LocalGraphView } from '@/lib/local-graph-view'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { localRunNodeStateDot, localRunNodeStateLabel } from './local-run-labels'

const COLUMN_WIDTH = 288
const ROW_HEIGHT = 208
const CARD_WIDTH = 256
const CARD_HEIGHT = 176

/**
 * One graph, laid out by the same deterministic layers Lane 3 uses for a server
 * workflow. Dependencies are drawn as arrows; a repeat edge (Build + Review going
 * back to its builder) is drawn dotted with the round counter, and is deliberately
 * not part of the layout — a loop is not a dependency.
 */
export function LocalRunCanvas({
  view,
  selectedId,
  onSelect
}: {
  view: LocalGraphView
  selectedId: string | null
  onSelect: (nodeId: string) => void
}) {
  const arrowId = useId().replace(/:/g, '')
  const layout = layoutConsoleWorkflow(view.nodes.map((n) => ({ key: n.id, after: n.after })))
  if (!layout.ok) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {layout.message}
      </p>
    )
  }
  if (view.nodes.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {translate('auto.components.local-run.Canvas.empty', 'This graph has no steps.')}
      </p>
    )
  }
  const byId = new Map(view.nodes.map((node) => [node.id, node]))
  const positions = new Map(
    layout.columns.flatMap((ids, column) =>
      ids.map((id, row) => [id, { x: column * COLUMN_WIDTH, y: row * ROW_HEIGHT + 32 }] as const)
    )
  )
  const width = layout.columns.length * COLUMN_WIDTH - 32
  const height = Math.max(...layout.columns.map((column) => column.length)) * ROW_HEIGHT + 32
  const edge = (from: string, to: string) => {
    const start = positions.get(from)
    const end = positions.get(to)
    return start && end ? { start, end } : null
  }
  return (
    <section
      aria-label={translate('auto.components.local-run.Canvas.label', 'Graph')}
      className="overflow-auto scrollbar-sleek"
    >
      <div className="relative" style={{ width, height }}>
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          width={width}
          height={height}
        >
          <defs>
            <marker id={arrowId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0 0 L8 4 L0 8" fill="var(--border)" />
            </marker>
          </defs>
          {view.nodes.flatMap((node) =>
            node.after.map((dependency) => {
              const line = edge(dependency, node.id)
              if (!line) {
                return null
              }
              const startX = line.start.x + CARD_WIDTH
              const middle = (startX + line.end.x) / 2
              return (
                <path
                  key={`dep:${dependency}:${node.id}`}
                  d={`M${startX} ${line.start.y + CARD_HEIGHT / 2} C${middle} ${line.start.y + CARD_HEIGHT / 2},${middle} ${line.end.y + CARD_HEIGHT / 2},${line.end.x} ${line.end.y + CARD_HEIGHT / 2}`}
                  fill="none"
                  stroke="var(--border)"
                  strokeWidth="2"
                  markerEnd={`url(#${arrowId})`}
                />
              )
            })
          )}
          {view.loops.map((loop) => {
            const line = edge(loop.to, loop.from)
            if (!line) {
              return null
            }
            const y = line.start.y + CARD_HEIGHT - 8
            return (
              <path
                key={`loop:${loop.from}:${loop.to}`}
                d={`M${line.end.x + 16} ${line.end.y + CARD_HEIGHT} C${line.end.x} ${y + 56},${line.start.x + CARD_WIDTH} ${y + 56},${line.start.x + CARD_WIDTH - 16} ${line.start.y + CARD_HEIGHT}`}
                fill="none"
                stroke="var(--border)"
                strokeWidth="2"
                strokeDasharray="4 4"
                markerEnd={`url(#${arrowId})`}
              />
            )
          })}
        </svg>
        {view.loops.map((loop) => {
          const position = positions.get(loop.to)
          return position ? (
            <span
              key={`round:${loop.from}:${loop.to}`}
              className="absolute flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-xs text-muted-foreground"
              style={{ left: position.x + 8, top: position.y + CARD_HEIGHT + 8 }}
            >
              <Repeat className="size-3.5 shrink-0" />
              {translate('auto.components.local-run.Canvas.round', 'Round')} {loop.round}/
              {loop.maxRounds}
            </span>
          ) : null
        })}
        {[...positions].map(([id, position]) => {
          const node = byId.get(id)
          return node ? (
            <LocalRunCanvasNode
              key={id}
              node={node}
              position={position}
              selected={selectedId === id}
              onSelect={onSelect}
            />
          ) : null
        })}
      </div>
    </section>
  )
}

function LocalRunCanvasNode({
  node,
  position,
  selected,
  onSelect
}: {
  node: LocalGraphNode
  position: { x: number; y: number }
  selected: boolean
  onSelect: (nodeId: string) => void
}) {
  const PlacementIcon =
    node.placement === 'fleet' ? Server : node.childWorkspaceName ? GitBranch : Folder
  return (
    <Button
      variant="outline"
      aria-pressed={selected}
      onClick={() => onSelect(node.id)}
      className={cn(
        'absolute flex h-44 w-64 flex-col items-start justify-start gap-1.5 overflow-hidden whitespace-normal bg-card p-3 text-left text-card-foreground',
        selected && 'ring-2 ring-ring'
      )}
      style={{ left: position.x, top: position.y }}
    >
      <span className="flex w-full items-center gap-2">
        <AgentStateDot state={localRunNodeStateDot(node.state)} />
        <span className="truncate text-sm font-medium">{node.id}</span>
      </span>
      <span className="flex max-w-full items-center gap-2">
        <Badge variant="outline">{localRunNodeStateLabel(node.state)}</Badge>
        <span className="truncate text-xs text-muted-foreground">
          {[node.actor.agent, node.actor.model, node.actor.effort].filter(Boolean).join(' · ')}
        </span>
      </span>
      <span className="flex max-w-full items-center gap-1 text-xs text-muted-foreground">
        <PlacementIcon className="size-3.5 shrink-0" />
        <span className="truncate" title={node.workspacePath}>
          {node.childWorkspaceName
            ? `${node.workspacePath} (${node.childWorkspaceName})`
            : node.workspacePath}
        </span>
      </span>
      <span className="text-xs text-muted-foreground">
        {translate('auto.components.local-run.Canvas.produced', 'Produced')}:{' '}
        {node.producedFiles.length}
      </span>
      {node.round !== null && (
        <span className="text-xs text-muted-foreground">
          {translate('auto.components.local-run.Canvas.round', 'Round')} {node.round}
        </span>
      )}
      {(node.gateQuestion || node.question) && (
        <span className="line-clamp-2 text-xs text-muted-foreground">
          {node.question?.question ?? node.gateQuestion}
        </span>
      )}
    </Button>
  )
}
