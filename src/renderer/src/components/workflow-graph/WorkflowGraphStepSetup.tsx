import { AlertTriangle, CheckCircle2, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import type {
  WorkflowRoute,
  WorkflowSpec,
  WorkflowStepKind
} from '../../../../shared/workflow-graph'
import type { WorkflowModelDefaults } from '../../../../shared/workflow-model-tiers'
import { workflowAddStep } from '../../../../shared/workflow-graph-edit'
import type { validateWorkflowSpec } from '../../../../shared/workflow-graph-validate'
import { WorkflowGraphCanvas } from './WorkflowGraphCanvas'
import { WorkflowRepeatControl } from './WorkflowRepeatControl'
import { WorkflowStepEditor } from './WorkflowStepEditor'
import type { WorkflowModelSource } from './workflow-model-sources'
import type { WorkflowSeatModelChoices } from './workflow-seat-model-choices'
import { workflowKindLabel } from './workflow-graph-labels'

const KINDS: WorkflowStepKind[] = ['do', 'review', 'rank', 'synthesize']

export function WorkflowGraphStepSetup({
  spec,
  normalized,
  routes,
  selected,
  models,
  sources,
  modelDefaults,
  validation,
  agentTotal,
  onSelect,
  onChange
}: {
  spec: WorkflowSpec
  normalized: WorkflowSpec
  routes: readonly WorkflowRoute[]
  selected?: string
  models?: WorkflowSeatModelChoices
  sources?: readonly WorkflowModelSource[]
  modelDefaults: WorkflowModelDefaults
  validation: ReturnType<typeof validateWorkflowSpec>
  agentTotal: number
  onSelect: (id: string | undefined) => void
  onChange: (spec: WorkflowSpec) => void
}) {
  const step = spec.steps.find((entry) => entry.id === selected)
  const problemsByStep = Object.fromEntries(
    normalized.steps.map((entry) => [
      entry.id,
      validation.problems.filter((problem) => problem.stepId === entry.id).length
    ])
  )
  const graphProblems = validation.problems.filter((problem) => !problem.stepId)
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-auto text-sm font-medium">{normalized.title}</h3>
        <WorkflowRepeatControl spec={normalized} available={routes} onChange={onChange} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="xs" className="gap-1">
              <Plus className="size-3" />
              {translate('workflowGraph.setup.addStep', 'Add step')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {KINDS.map((kind) => (
              <DropdownMenuItem
                key={kind}
                onSelect={() => {
                  const next = workflowAddStep(normalized, kind, routes, selected)
                  onChange(next)
                  onSelect(next.steps.at(-1)?.id)
                }}
              >
                {workflowKindLabel(kind)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <WorkflowGraphCanvas
        spec={normalized}
        problems={problemsByStep}
        selectedId={selected}
        onSelect={(id) => onSelect(id === selected ? undefined : id)}
      />
      {step && (
        <WorkflowStepEditor
          spec={spec}
          step={step}
          available={routes}
          models={models}
          sources={sources}
          modelDefaults={modelDefaults}
          problems={validation.problems.filter((problem) => problem.stepId === step.id)}
          onChange={onChange}
          onClose={() => onSelect(undefined)}
        />
      )}
      {graphProblems.length > 0 || validation.problems.length > 0 ? (
        <div role="alert" className="space-y-1 text-xs text-destructive">
          {(graphProblems.length ? graphProblems : validation.problems.slice(0, 3)).map(
            (problem) => (
              <p key={problem.message} className="flex items-start gap-1.5">
                <AlertTriangle aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
                {problem.message}
              </p>
            )
          )}
        </div>
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CheckCircle2 aria-hidden="true" className="size-3 text-status-success" />
          {translate('workflowGraph.setup.ready', 'Ready · up to {{count}} agent calls', {
            count: agentTotal
          })}
        </p>
      )}
      {validation.warnings.map((warning) => (
        <p key={warning.message} className="text-xs text-muted-foreground">
          {warning.message}
        </p>
      ))}
    </section>
  )
}
