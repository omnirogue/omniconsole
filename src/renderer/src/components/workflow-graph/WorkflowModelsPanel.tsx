import { useState } from 'react'
import { translate } from '@/i18n/i18n'
import {
  workflowKindJudges,
  type WorkflowRoute,
  type WorkflowSpec
} from '../../../../shared/workflow-graph'
import {
  applyWorkflowModelTier,
  withWorkflowAgentModel,
  withWorkflowStepModels,
  workflowSpecTier,
  workflowStepTier,
  type WorkflowModelDefaults,
  type WorkflowModelTier
} from '../../../../shared/workflow-model-tiers'
import { WorkflowModelDescribe } from './WorkflowModelDescribe'
import { WorkflowModelComboPicker, WorkflowModelPicker } from './WorkflowModelPicker'
import { WorkflowModelPresets } from './WorkflowModelPresets'
import { WorkflowModelTierEditor } from './WorkflowModelTierEditor'
import { WorkflowTierToggle, workflowTierLabel } from './WorkflowTierToggle'
import type { WorkflowModelTierState } from './use-workflow-model-tiers'
import { workflowAgentKeys } from './workflow-graph-controls'
import { workflowKindLabel } from './workflow-graph-labels'
import type { WorkflowModelSource } from './workflow-model-sources'

/**
 * Which model runs every step, on one card: a tier for the whole workflow or for one step, each
 * agent's own model (with its logo) one click away, a combo of providers on a step, and a line
 * to say it in words instead. It only ever changes models, so it sits above every kind of
 * workflow, templates included.
 */
export function WorkflowModelsPanel({
  worktreeId,
  spec,
  available,
  sources,
  defaults,
  tierState,
  onChange
}: {
  worktreeId: string
  spec: WorkflowSpec
  available: readonly WorkflowRoute[]
  sources: readonly WorkflowModelSource[]
  defaults: WorkflowModelDefaults
  /** Owned by the setup screen, so a described workflow uses the same lineups. */
  tierState: WorkflowModelTierState
  onChange: (spec: WorkflowSpec) => void
}) {
  const { tiers, customized, saveError, save } = tierState
  const [note, setNote] = useState('')
  const applyTier = (tier: WorkflowModelTier, stepId?: string) => {
    const applied = applyWorkflowModelTier(spec, {
      tier,
      tiers,
      available,
      defaults,
      ...(stepId ? { stepId } : {})
    })
    onChange(applied.spec)
    setNote(
      applied.unchanged.length
        ? translate(
            'workflowGraph.tiers.unchanged',
            'Left as they were, because the {{tier}} tier has no model they can run here: {{steps}}. Add one under Adjust tiers.',
            {
              tier: workflowTierLabel(tier),
              steps: spec.steps
                .filter((step) => applied.unchanged.includes(step.id))
                .map((step) => step.title)
                .join(', ')
            }
          )
        : ''
    )
  }
  return (
    <section
      aria-label={translate('workflowGraph.models.panel', 'Models')}
      className="space-y-2 rounded-xl border bg-card p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-auto text-sm font-medium">
          {translate('workflowGraph.models.panel', 'Models')}
        </h3>
        <WorkflowTierToggle
          value={workflowSpecTier(spec, tiers, defaults)}
          label={translate('workflowGraph.tiers.allSteps', 'Tier for every step')}
          onChange={(tier) => applyTier(tier)}
        />
        <WorkflowModelTierEditor
          tiers={tiers}
          customized={customized}
          saveError={saveError}
          available={available}
          sources={sources}
          defaults={defaults}
          onSave={(next) => void save(next)}
        />
        <WorkflowModelPresets
          spec={spec}
          label={translate('workflowGraph.models.saved', 'Saved')}
          onChange={onChange}
        />
      </div>
      <ul className="divide-y">
        {spec.steps.map((step) => {
          const judge = workflowKindJudges(step.kind)
          const keys = workflowAgentKeys(step.agents)
          return (
            <li key={step.id} className="flex flex-wrap items-center gap-2 py-1.5">
              <div className="flex w-36 min-w-0 flex-col">
                <span className="truncate text-xs font-medium" title={step.title}>
                  {step.title}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {workflowKindLabel(step.kind)}
                </span>
              </div>
              <div className="flex min-w-0 flex-1 flex-wrap gap-1">
                {step.agents.map((agent, index) => (
                  <WorkflowModelPicker
                    key={keys[index]}
                    value={agent}
                    sources={sources}
                    defaults={defaults}
                    judge={judge}
                    onChange={(model) => {
                      onChange(withWorkflowAgentModel(spec, step.id, index, model, defaults))
                      setNote('')
                    }}
                  />
                ))}
              </div>
              {step.kind !== 'synthesize' && (
                <WorkflowModelComboPicker
                  value={step.agents}
                  sources={sources}
                  defaults={defaults}
                  judge={judge}
                  onApply={(models) => {
                    onChange(withWorkflowStepModels(spec, step.id, models, defaults))
                    setNote('')
                  }}
                />
              )}
              <WorkflowTierToggle
                value={workflowStepTier(step, tiers, defaults)}
                label={translate('workflowGraph.tiers.forStep', 'Tier for {{step}}', {
                  step: step.title
                })}
                onChange={(tier) => applyTier(tier, step.id)}
              />
            </li>
          )
        })}
      </ul>
      {note && (
        <p role="status" className="text-xs text-muted-foreground">
          {note}
        </p>
      )}
      <WorkflowModelDescribe
        worktreeId={worktreeId}
        spec={spec}
        tiers={tiers}
        available={available}
        sources={sources}
        defaults={defaults}
        onChange={(next) => {
          onChange(next)
          setNote('')
        }}
      />
    </section>
  )
}
