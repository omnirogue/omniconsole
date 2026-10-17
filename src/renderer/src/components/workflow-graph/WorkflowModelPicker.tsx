import { useState } from 'react'
import { ChevronsUpDown, Layers } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import { WorkflowModelLogo } from '@/lib/workflow-model-logo'
import { cn } from '@/lib/utils'
import { localWorkflowProviderLabel } from '../../../../shared/local-workflow-model-label'
import { localWorkflowRouteNamesModel } from '../../../../shared/local-workflow-seats'
import { WORKFLOW_MAX_AGENTS_PER_STEP } from '../../../../shared/workflow-graph'
import type { WorkflowPresetModel } from '../../../../shared/workflow-model-presets'
import {
  sameWorkflowModel,
  type WorkflowModelDefaults
} from '../../../../shared/workflow-model-tiers'
import type { WorkflowOpenRouterPriceBand } from '../../../../shared/workflow-openrouter-models'
import { WorkflowModelList } from './WorkflowModelList'
import { workflowModelLabel, type WorkflowModelSource } from './workflow-model-sources'

/** A model as it reads everywhere: its maker's logo, its name, and the route when that is not obvious. */
export function WorkflowModelChip({
  model,
  sources,
  className
}: {
  model: WorkflowPresetModel
  sources: readonly WorkflowModelSource[]
  className?: string
}) {
  const via = localWorkflowRouteNamesModel(model.route)
    ? localWorkflowProviderLabel(model.route)
    : undefined
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
      <WorkflowModelLogo route={model.route} model={model.model} size={13} />
      <span className="truncate">{workflowModelLabel(model, sources)}</span>
      {via && <span className="shrink-0 text-[10px] text-muted-foreground">{via}</span>}
    </span>
  )
}

/** One agent's model: a button showing it, opening the full list. */
export function WorkflowModelPicker({
  value,
  sources,
  defaults,
  judge,
  band,
  label,
  onChange
}: {
  /** The model shown on the button; absent, the button reads `label`. */
  value?: WorkflowPresetModel
  sources: readonly WorkflowModelSource[]
  defaults: WorkflowModelDefaults
  judge?: boolean
  band?: WorkflowOpenRouterPriceBand
  label?: string
  onChange: (model: WorkflowPresetModel) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="max-w-60 gap-1"
          aria-label={
            value
              ? translate('workflowGraph.models.change', 'Change model: {{model}}', {
                  model: workflowModelLabel(value, sources)
                })
              : label
          }
        >
          {value ? <WorkflowModelChip model={value} sources={sources} /> : label}
          <ChevronsUpDown className="size-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-96 p-0" align="start">
        <WorkflowModelList
          sources={sources}
          judge={judge}
          band={band}
          isSelected={(model) => !!value && sameWorkflowModel(model, value, defaults)}
          onPick={(model) => {
            onChange(model)
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

/**
 * A combo: tick models from any providers and the step runs one agent on each. Nothing changes
 * until Apply, so a half-chosen combo never reshapes the step.
 */
export function WorkflowModelComboPicker({
  value,
  sources,
  defaults,
  judge,
  onApply
}: {
  /** The models the step runs now, ticked when the list opens. */
  value: readonly WorkflowPresetModel[]
  sources: readonly WorkflowModelSource[]
  defaults: WorkflowModelDefaults
  judge?: boolean
  onApply: (models: WorkflowPresetModel[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<WorkflowPresetModel[]>([])
  const full = picked.length >= WORKFLOW_MAX_AGENTS_PER_STEP
  const toggle = (model: WorkflowPresetModel) =>
    setPicked((current) =>
      current.some((entry) => sameWorkflowModel(entry, model, defaults))
        ? current.filter((entry) => !sameWorkflowModel(entry, model, defaults))
        : current.length < WORKFLOW_MAX_AGENTS_PER_STEP
          ? [...current, model]
          : current
    )
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          // One of each: a step that runs the same model twice still starts with it ticked once.
          setPicked(
            value.filter(
              (model, index) =>
                value.findIndex((entry) => sameWorkflowModel(entry, model, defaults)) === index
            )
          )
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="xs" className="gap-1">
          <Layers className="size-3" />
          {translate('workflowGraph.models.combo', 'Combo')}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-96 p-0" align="end">
        <WorkflowModelList
          sources={sources}
          judge={judge}
          isSelected={(model) => picked.some((entry) => sameWorkflowModel(entry, model, defaults))}
          onPick={toggle}
        />
        <div className="space-y-2 border-t p-2">
          <div className="flex flex-wrap gap-1 text-xs">
            {picked.map((model) => (
              <WorkflowModelChip
                key={`${model.route}:${model.model ?? ''}`}
                model={model}
                sources={sources}
                className="rounded-md border px-1.5 py-0.5"
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="mr-auto text-xs text-muted-foreground">
              {full
                ? translate(
                    'workflowGraph.models.comboFull',
                    '{{count}} models: the most one step runs',
                    { count: picked.length }
                  )
                : translate(
                    'workflowGraph.models.comboHint',
                    'One agent per model, from any providers'
                  )}
            </span>
            <Button
              type="button"
              size="xs"
              disabled={!picked.length}
              onClick={() => {
                onApply(picked)
                setOpen(false)
              }}
            >
              {translate('workflowGraph.models.comboApply', 'Run these {{count}}', {
                count: picked.length
              })}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
