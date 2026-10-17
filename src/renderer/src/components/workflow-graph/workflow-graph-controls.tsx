import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { WorkflowAgentSpec, WorkflowStepKind } from '../../../../shared/workflow-graph'

/** Placeholders for an empty instruction: what the step does when left to its kind's default. */
export const GRAPH_DEFAULT_INSTRUCTION_HINTS: Record<WorkflowStepKind, () => string> = {
  do: () =>
    translate(
      'workflowGraph.editor.doHint',
      'Leave empty to work on the task as asked, or say what these agents should do.'
    ),
  review: () =>
    translate(
      'workflowGraph.editor.reviewHint',
      'Critically review the work against the task, point out errors and gaps, say how to fix each.'
    ),
  rank: () =>
    translate(
      'workflowGraph.editor.rankHint',
      'Leave empty to evaluate each answer and rank them from best to worst.'
    ),
  synthesize: () =>
    translate(
      'workflowGraph.editor.synthesizeHint',
      'Write the single best final answer from the work below and correct what the reviews found.'
    )
}

/** A compact labelled select for the editor. The empty value is allowed as an option. */
export function WorkflowSelect({
  value,
  options,
  onChange,
  className
}: {
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
  className?: string
}) {
  // Radix Select reserves the empty string; map it to a sentinel and back.
  const NONE = '__none__'
  return (
    <Select value={value || NONE} onValueChange={(next) => onChange(next === NONE ? '' : next)}>
      <SelectTrigger size="sm" className={cn('h-8 text-xs', className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value || NONE} value={option.value || NONE} className="text-xs">
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** Stable React keys for a step's agents: the family and its occurrence ("claude-2"). */
export function workflowAgentKeys(agents: readonly WorkflowAgentSpec[]): string[] {
  const seen = new Map<string, number>()
  return agents.map((agent) => {
    const count = (seen.get(agent.route) ?? 0) + 1
    seen.set(agent.route, count)
    return `${agent.route}-${count}`
  })
}
