import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import {
  WORKFLOW_MODEL_TIERS,
  type WorkflowModelTier
} from '../../../../shared/workflow-model-tiers'

export function workflowTierLabel(tier: WorkflowModelTier): string {
  return tier === 'cheap'
    ? translate('workflowGraph.tiers.cheap', 'Cheap')
    : tier === 'standard'
      ? translate('workflowGraph.tiers.standard', 'Standard')
      : translate('workflowGraph.tiers.frontier', 'Frontier')
}

export function workflowTierHint(tier: WorkflowModelTier): string {
  return tier === 'cheap'
    ? translate(
        'workflowGraph.tiers.cheapHint',
        'Light, fast models: free and low-cost ones belong here.'
      )
    : tier === 'standard'
      ? translate('workflowGraph.tiers.standardHint', 'Balanced models for everyday work.')
      : translate('workflowGraph.tiers.frontierHint', 'The strongest model of each family.')
}

/** Cheap · Standard · Frontier as one control; none is lit when the models match no single tier. */
export function WorkflowTierToggle({
  value,
  label,
  onChange
}: {
  value?: WorkflowModelTier
  /** What the tier applies to, for screen readers: "All steps", or a step's title. */
  label: string
  onChange: (tier: WorkflowModelTier) => void
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex shrink-0 items-center gap-0.5 rounded-md border p-0.5"
    >
      {WORKFLOW_MODEL_TIERS.map((tier) => (
        <Button
          key={tier}
          type="button"
          size="xs"
          variant={tier === value ? 'default' : 'ghost'}
          aria-pressed={tier === value}
          title={workflowTierHint(tier)}
          className="h-5 px-1.5"
          onClick={() => onChange(tier)}
        >
          {workflowTierLabel(tier)}
        </Button>
      ))}
    </div>
  )
}
