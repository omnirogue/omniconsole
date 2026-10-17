import { useId } from 'react'
import { ListOrdered, Merge, Repeat, SearchCheck, Zap, type LucideIcon } from 'lucide-react'
import { WorkflowProviderIcon as AgentIcon } from '@/lib/workflow-provider-icon'
import { modelToneBorderClass } from '@/components/ModelDot'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { LocalWorkflowGraphState } from '../../../../shared/local-workflow-view'
import type { WorkflowSpec, WorkflowStepKind } from '../../../../shared/workflow-graph'
import { workflowTopology } from '../../../../shared/workflow-graph-topology'
import { WORKFLOW_STATE_DOT, workflowKindLabel, workflowStateLabel } from './workflow-graph-labels'
import { workflowAgentKeys } from './workflow-graph-controls'

const COLUMN = 252
const ROW = 138
const CARD_W = 212
const CARD_H = 108
const TOP = 8

export function workflowKindIcon(kind: WorkflowStepKind): LucideIcon {
  switch (kind) {
    case 'do':
      return Zap
    case 'review':
      return SearchCheck
    case 'rank':
      return ListOrdered
    case 'synthesize':
      return Merge
  }
}

export type WorkflowStepStatus = {
  state: LocalWorkflowGraphState
  done: number
  total: number
  round?: number
}

/**
 * The workflow as it runs: columns are dependency levels (everything in one column can run at
 * once), arrows are inputs, a dashed arrow is a repeat. The same drawing is the editor before
 * Start and the live run after it.
 */
export function WorkflowGraphCanvas({
  spec,
  status,
  problems,
  selectedId,
  onSelect
}: {
  spec: WorkflowSpec
  /** Run mode: each step's live state. */
  status?: Record<string, WorkflowStepStatus>
  /** Design mode: how many problems each step has. */
  problems?: Record<string, number>
  selectedId?: string
  onSelect?: (stepId: string) => void
}) {
  const arrowId = useId().replace(/:/g, '')
  const { level } = workflowTopology(spec)
  const columns: string[][] = []
  for (const step of spec.steps) {
    const column = level.get(step.id) ?? 0
    ;(columns[column] ??= []).push(step.id)
  }
  const position = new Map<string, { x: number; y: number }>()
  columns.forEach((ids, column) =>
    ids.forEach((id, row) => position.set(id, { x: column * COLUMN, y: TOP + row * ROW }))
  )
  const rows = Math.max(1, ...columns.map((ids) => ids?.length ?? 0))
  const repeat = spec.repeat
  const width = Math.max(CARD_W, (columns.length - 1) * COLUMN + CARD_W) + 8
  const height = TOP + rows * ROW + (repeat ? 36 : 0)
  const byId = new Map(spec.steps.map((step) => [step.id, step]))
  return (
    <div className="overflow-x-auto pb-1 scrollbar-sleek">
      <div
        role="group"
        aria-label={translate('workflowGraph.canvas.label', 'Workflow steps')}
        className="relative"
        style={{ width, height }}
      >
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          width={width}
          height={height}
        >
          <defs>
            <marker id={arrowId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0 0 L8 4 L0 8" fill="var(--muted-foreground)" />
            </marker>
          </defs>
          {spec.steps.flatMap((step) =>
            step.inputs.map((input) => {
              const from = position.get(input)
              const to = position.get(step.id)
              if (!from || !to) {
                return null
              }
              const x1 = from.x + CARD_W
              const y1 = from.y + CARD_H / 2
              const y2 = to.y + CARD_H / 2
              const middle = (x1 + to.x) / 2
              return (
                <path
                  key={`${input}->${step.id}`}
                  d={`M${x1} ${y1} C${middle} ${y1},${middle} ${y2},${to.x - 2} ${y2}`}
                  fill="none"
                  stroke="var(--muted-foreground)"
                  strokeOpacity="0.5"
                  strokeWidth="1.5"
                  markerEnd={`url(#${arrowId})`}
                />
              )
            })
          )}
          {repeat && position.get(repeat.do) && position.get(repeat.review)
            ? (() => {
                const from = position.get(repeat.review)!
                const to = position.get(repeat.do)!
                const y = Math.max(from.y, to.y) + CARD_H + 22
                return (
                  <path
                    d={`M${from.x + CARD_W / 2} ${from.y + CARD_H} C${from.x + CARD_W / 2} ${y},${to.x + CARD_W / 2} ${y},${to.x + CARD_W / 2} ${to.y + CARD_H + 2}`}
                    fill="none"
                    stroke="var(--muted-foreground)"
                    strokeOpacity="0.6"
                    strokeWidth="1.5"
                    strokeDasharray="4 4"
                    markerEnd={`url(#${arrowId})`}
                  />
                )
              })()
            : null}
        </svg>
        {repeat && position.get(repeat.do) && position.get(repeat.review) ? (
          <span
            className="absolute flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-[11px] text-muted-foreground"
            style={{
              left: (position.get(repeat.do)!.x + position.get(repeat.review)!.x + CARD_W) / 2 - 70,
              top:
                Math.max(position.get(repeat.do)!.y, position.get(repeat.review)!.y) + CARD_H + 10
            }}
          >
            <Repeat aria-hidden="true" className="size-3" />
            {repeat.until === 'approved'
              ? translate('workflowGraph.repeat.approved', 'until approved · max {{count}}', {
                  count: repeat.maxRounds
                })
              : repeat.until === 'plateau'
                ? translate('workflowGraph.repeat.plateau', 'until no gain · max {{count}}', {
                    count: repeat.maxRounds
                  })
                : translate(
                    'workflowGraph.repeat.nothingNew',
                    'until nothing new · max {{count}}',
                    { count: repeat.maxRounds }
                  )}
          </span>
        ) : null}
        {spec.steps.map((step) => {
          const at = position.get(step.id)!
          const Icon = workflowKindIcon(step.kind)
          const run = status?.[step.id]
          const issues = problems?.[step.id] ?? 0
          const source = step.forEach ? byId.get(step.forEach.step)?.title : undefined
          return (
            <button
              key={step.id}
              type="button"
              aria-pressed={selectedId === step.id}
              aria-label={`${step.title}, ${workflowKindLabel(step.kind)}${run ? `, ${workflowStateLabel(run.state)}` : ''}`}
              onClick={() => onSelect?.(step.id)}
              className={cn(
                'absolute flex flex-col gap-1.5 rounded-lg border bg-card p-2.5 text-left shadow-xs transition-colors hover:bg-accent/40',
                selectedId === step.id && 'ring-2 ring-ring',
                issues > 0 && 'border-destructive',
                run?.state === 'running' && 'border-status-info-border'
              )}
              style={{ left: at.x, top: at.y, width: CARD_W, height: CARD_H }}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate text-sm font-medium">{step.title}</span>
              </span>
              <span className="truncate text-[11px] text-muted-foreground">
                {workflowKindLabel(step.kind)}
                {source
                  ? ` · ${translate('workflowGraph.card.forEach', 'for each from {{source}}', { source })}`
                  : ''}
                {step.list ? ` · ${translate('workflowGraph.card.list', 'lists items')}` : ''}
              </span>
              <span className="flex flex-wrap items-center gap-1">
                {step.agents.map((agent, index) => (
                  <span
                    key={workflowAgentKeys(step.agents)[index]}
                    title={agent.angle ?? agent.route}
                    className={cn(
                      'flex size-5 items-center justify-center rounded-full border-2 bg-background',
                      modelToneBorderClass(agent.route, agent.model)
                    )}
                  >
                    <AgentIcon agent={agent.route} size={11} />
                  </span>
                ))}
              </span>
              <span className="mt-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
                {run ? (
                  <>
                    <span
                      className={cn(
                        'size-1.5 shrink-0 rounded-full',
                        WORKFLOW_STATE_DOT[run.state]
                      )}
                    />
                    {workflowStateLabel(run.state)}
                    {run.total ? ` · ${run.done}/${run.total}` : ''}
                    {run.round && repeat
                      ? ` · ${translate('workflowGraph.card.round', 'round {{round}}', { round: run.round })}`
                      : ''}
                  </>
                ) : issues ? (
                  <span className="text-destructive">
                    {translate('workflowGraph.card.problems', '{{count}} to fix', {
                      count: issues
                    })}
                  </span>
                ) : step.agents.length === 1 ? (
                  translate('workflowGraph.card.oneAgent', '1 agent')
                ) : (
                  translate('workflowGraph.card.agents', '{{count}} in parallel', {
                    count: step.agents.length
                  })
                )}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
