import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import type { WorkflowSpec } from '../../../../shared/workflow-graph'
import { workflowFinishReserve } from '../../../../shared/workflow-graph-topology'

/**
 * Most agents a run may start, the final step's included. Empty means the workflow's own bound;
 * once the cap is reached the run stops starting agents and the final step reports on what is in.
 */
export function WorkflowMaxAgentsField({
  spec,
  planned,
  value,
  onChange
}: {
  spec: WorkflowSpec
  planned: number
  value?: number
  onChange: (value: number | undefined) => void
}) {
  const finish = workflowFinishReserve(spec)
  if (!finish || planned <= finish.reserve + 1) {
    return null
  }
  const minimum = finish.reserve + 1
  const invalid = value !== undefined && (value < minimum || value > planned)
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {translate('workflowGraph.setup.maxAgents', 'Max agents')}
      <Input
        type="number"
        inputMode="numeric"
        min={minimum}
        max={planned}
        className="h-7 w-20 text-xs"
        aria-invalid={invalid || undefined}
        placeholder={String(planned)}
        value={value ?? ''}
        title={translate(
          'workflowGraph.setup.maxAgentsHint',
          'Stop starting agents at this many; the report then uses what is in. At least {{minimum}}.',
          { minimum }
        )}
        onChange={(event) => {
          const next = event.target.value.trim()
          const parsed = Number(next)
          onChange(next && Number.isInteger(parsed) && parsed > 0 ? parsed : undefined)
        }}
      />
    </label>
  )
}

/** The cap the run starts with: none when unset or not below the workflow's own bound. */
export function workflowMaxAgentsForStart(
  spec: WorkflowSpec,
  planned: number,
  value?: number
): number | undefined {
  const finish = workflowFinishReserve(spec)
  if (!finish || value === undefined || value >= planned) {
    return undefined
  }
  return Math.max(value, finish.reserve + 1)
}
