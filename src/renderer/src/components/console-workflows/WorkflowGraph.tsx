import { useId } from 'react'
import { ArrowRight, Diamond, Monitor, Server, User } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { layoutConsoleWorkflow } from '@/lib/console-workflow-layout'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { WorkflowError } from './WorkflowFields'

export type WorkflowGraphNode = {
  key: string
  title: string
  after?: readonly string[]
  actorType?: string
  status?: string
  placement?: string
  machine?: string | null
  conditions?: unknown
  incoming?: readonly { from: string; label: string; selected?: boolean }[]
}

export function WorkflowGraph({
  nodes,
  selectedKey,
  onSelect
}: {
  nodes: readonly WorkflowGraphNode[]
  selectedKey: string | null
  onSelect: (key: string) => void
}) {
  const arrowId = useId().replace(/:/g, '')
  const layout = layoutConsoleWorkflow(nodes)
  if (!layout.ok) {
    return <WorkflowError message={layout.message} />
  }
  if (!nodes.length) {
    return (
      <p className="text-sm text-muted-foreground">
        {translate('consoleWorkflows.noStages', 'No stages in this server view.')}
      </p>
    )
  }
  const byKey = new Map(nodes.map((node) => [node.key, node]))
  const positions = new Map(
    layout.columns.flatMap((keys, column) =>
      keys.map((key, row) => [key, { x: column * 288, y: row * 192 + 32 }] as const)
    )
  )
  const width = layout.columns.length * 288 - 32
  const height = Math.max(...layout.columns.map((column) => column.length)) * 192
  return (
    <section
      aria-label={translate('consoleWorkflows.graph', 'Workflow graph')}
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
          {nodes.flatMap((node) =>
            (node.after ?? []).map((key) => {
              const from = positions.get(key)!
              const to = positions.get(node.key)!
              const startX = from.x + 256
              const endX = to.x
              const middle = (startX + endX) / 2
              const edge = node.incoming?.find((edge) => edge.from === key)
              return (
                <g key={`${key}:${node.key}`}>
                  <path
                    key={`${key}:${node.key}`}
                    d={`M${startX} ${from.y + 80} C${middle} ${from.y + 80},${middle} ${to.y + 80},${endX} ${to.y + 80}`}
                    fill="none"
                    stroke={edge?.selected ? 'var(--foreground)' : 'var(--border)'}
                    opacity={edge?.selected === false ? 0.4 : 1}
                    strokeWidth="2"
                    markerEnd={`url(#${arrowId})`}
                  />
                  {edge?.label && (
                    <text
                      x={middle}
                      y={(from.y + to.y) / 2 + 68}
                      fill="var(--muted-foreground)"
                      textAnchor="middle"
                      fontSize="11"
                    >
                      {edge.label}
                    </text>
                  )}
                </g>
              )
            })
          )}
        </svg>
        {layout.columns.map((keys, column) => (
          <div
            key={keys.join(':')}
            className="absolute text-xs text-muted-foreground"
            style={{ left: column * 288 }}
          >
            {translate('consoleWorkflows.stageLayer', 'Layer')} {column + 1}
          </div>
        ))}
        {[...positions].map(([key, position]) => {
          const node = byKey.get(key)!
          const MachineIcon =
            node.actorType === 'human' ? User : node.placement === 'fleet' ? Server : Monitor
          return (
            <Button
              key={key}
              variant="outline"
              aria-pressed={selectedKey === key}
              onClick={() => onSelect(key)}
              className={cn(
                'absolute flex h-40 w-64 flex-col items-start justify-start gap-2 overflow-hidden whitespace-normal bg-card p-3 text-left text-card-foreground',
                node.status === 'skipped' && 'opacity-50',
                selectedKey === key && 'ring-2 ring-ring'
              )}
              style={{ left: position.x, top: position.y }}
            >
              <span className="line-clamp-2 text-sm font-medium">
                {(node.after?.length ?? 0) > 1 && (
                  <Diamond
                    className="mr-1 inline size-3"
                    aria-label={translate('unifiedWork.join', 'Join')}
                  />
                )}
                {node.title || node.key}
              </span>
              <span className="flex max-w-full items-center gap-2">
                <Badge variant="outline">
                  {node.status ?? translate('consoleWorkflows.previewStage', 'Preview')}
                </Badge>
                <span className="truncate text-xs text-muted-foreground">{node.actorType}</span>
              </span>
              <span className="flex max-w-full items-center gap-1 text-xs text-muted-foreground">
                <MachineIcon className="size-3.5 shrink-0" />
                <span className="truncate">
                  {node.machine ||
                    node.placement ||
                    translate('consoleWorkflows.unassigned', 'Unassigned')}
                </span>
              </span>
              {!!node.after?.length && (
                <span className="flex max-w-full items-center gap-1 text-xs text-muted-foreground">
                  <ArrowRight className="size-3.5 shrink-0" />
                  <span className="truncate">
                    {translate('consoleWorkflows.after', 'After')}: {node.after.join(', ')}
                  </span>
                </span>
              )}
              {node.conditions != null && (
                <span className="line-clamp-1 text-xs text-muted-foreground">
                  {translate('consoleWorkflows.conditions', 'Conditions')}:{' '}
                  {typeof node.conditions === 'string'
                    ? node.conditions
                    : JSON.stringify(node.conditions)}
                </span>
              )}
            </Button>
          )
        })}
      </div>
    </section>
  )
}
