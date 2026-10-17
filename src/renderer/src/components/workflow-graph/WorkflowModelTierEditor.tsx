import { SlidersHorizontal, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import type { WorkflowRoute } from '../../../../shared/workflow-graph'
import {
  WORKFLOW_MODEL_TIERS,
  WORKFLOW_TIER_MAX_MODELS,
  sameWorkflowModel,
  type WorkflowModelDefaults,
  type WorkflowModelTier,
  type WorkflowModelTiers
} from '../../../../shared/workflow-model-tiers'
import { WorkflowModelChip, WorkflowModelPicker } from './WorkflowModelPicker'
import { workflowTierHint, workflowTierLabel } from './WorkflowTierToggle'
import type { WorkflowModelSource } from './workflow-model-sources'

/**
 * What each tier means, changed in place: remove a model, or add any from the full list (the
 * Cheap tier's list opens on OpenRouter's free models). The first model of a lineup is the one a
 * single-agent step gets. Every change is saved for all workflows on this computer.
 */
export function WorkflowModelTierEditor({
  tiers,
  customized,
  saveError,
  available,
  sources,
  defaults,
  onSave
}: {
  tiers: WorkflowModelTiers
  customized: boolean
  saveError: boolean
  available: readonly WorkflowRoute[]
  sources: readonly WorkflowModelSource[]
  defaults: WorkflowModelDefaults
  onSave: (tiers: WorkflowModelTiers | null) => void
}) {
  const set = (tier: WorkflowModelTier, lineup: WorkflowModelTiers[WorkflowModelTier]) =>
    onSave({ ...tiers, [tier]: lineup })
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="xs" className="gap-1">
          <SlidersHorizontal className="size-3" />
          {translate('workflowGraph.tiers.adjust', 'Adjust tiers')}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[26rem] space-y-3 p-3">
        {WORKFLOW_MODEL_TIERS.map((tier) => (
          <section key={tier} className="space-y-1.5">
            <div>
              <h4 className="text-sm font-medium">{workflowTierLabel(tier)}</h4>
              <p className="text-xs text-muted-foreground">{workflowTierHint(tier)}</p>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              {tiers[tier].map((model, index) => (
                <span
                  key={`${model.route}:${model.model ?? ''}`}
                  className="inline-flex items-center gap-1 rounded-md border py-0.5 pl-1.5 pr-0.5 text-xs"
                  title={
                    available.includes(model.route)
                      ? undefined
                      : translate(
                          'workflowGraph.tiers.notSetUp',
                          'Not set up on this computer, so steps skip it.'
                        )
                  }
                >
                  <WorkflowModelChip
                    model={model}
                    sources={sources}
                    className={available.includes(model.route) ? undefined : 'opacity-50'}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="size-4"
                    disabled={tiers[tier].length < 2}
                    aria-label={translate('workflowGraph.tiers.remove', 'Remove from {{tier}}', {
                      tier: workflowTierLabel(tier)
                    })}
                    onClick={() =>
                      set(
                        tier,
                        tiers[tier].filter((_, position) => position !== index)
                      )
                    }
                  >
                    <X className="size-3" />
                  </Button>
                </span>
              ))}
              {tiers[tier].length < WORKFLOW_TIER_MAX_MODELS && (
                <WorkflowModelPicker
                  sources={sources}
                  defaults={defaults}
                  band={tier === 'cheap' ? 'free' : 'standard'}
                  label={translate('workflowGraph.tiers.add', 'Add model')}
                  onChange={(model) => {
                    // A family's default is stored by name, so the tier stays the same model.
                    const named = { ...model, model: model.model ?? defaults[model.route] }
                    if (!tiers[tier].some((entry) => sameWorkflowModel(entry, named, defaults))) {
                      set(tier, [...tiers[tier], named])
                    }
                  }}
                />
              )}
            </div>
          </section>
        ))}
        <div className="flex items-center gap-2 border-t pt-2">
          <p className="mr-auto text-xs text-muted-foreground">
            {saveError
              ? translate(
                  'workflowGraph.tiers.saveError',
                  'Could not save: these tiers apply until this window closes.'
                )
              : translate(
                  'workflowGraph.tiers.saved',
                  'Saved for every workflow on this computer.'
                )}
          </p>
          {customized && (
            <Button type="button" variant="ghost" size="xs" onClick={() => onSave(null)}>
              {translate('workflowGraph.tiers.reset', 'Back to built-in tiers')}
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
