import { Plus, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import {
  WORKFLOW_MAX_AGENTS_PER_STEP,
  workflowKindJudges,
  workflowRouteMayJudge,
  type WorkflowProblem,
  type WorkflowRoute,
  type WorkflowSpec,
  type WorkflowStep,
  type WorkflowStepKind
} from '../../../../shared/workflow-graph'
import {
  workflowAllowedInputs,
  workflowPatchStep,
  workflowRemoveStep,
  workflowUpdateStep
} from '../../../../shared/workflow-graph-edit'
import {
  GRAPH_DEFAULT_INSTRUCTION_HINTS,
  WorkflowSelect,
  workflowAgentKeys
} from './workflow-graph-controls'
import { workflowKindHint, workflowKindLabel } from './workflow-graph-labels'
import { WorkflowAgentRow } from './WorkflowAgentRow'
import type { WorkflowSeatModelChoices } from './workflow-seat-model-choices'
import type { WorkflowModelSource } from './workflow-model-sources'
import { localWorkflowRouteNamesModel } from '../../../../shared/local-workflow-seats'
import {
  withWorkflowAgentModel,
  type WorkflowModelDefaults
} from '../../../../shared/workflow-model-tiers'
import { WorkflowJudgeFields } from './WorkflowJudgeFields'
import { WorkflowWebPagesField } from './WorkflowWebPagesField'
import { workflowWebRefusalLabel } from './web-page-reason-label'
import { withWebPages, workflowWebRefusal } from '../../../../shared/workflow-web-pages'

const KINDS: WorkflowStepKind[] = ['do', 'review', 'rank', 'synthesize']

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
      {label}
      {children}
    </label>
  )
}

/**
 * The selected step, editable. Every change goes through the shared edit functions and comes
 * back normalized; inputs only offer steps that do not already depend on this one.
 */
export function WorkflowStepEditor({
  spec,
  step,
  available,
  models,
  sources,
  modelDefaults,
  problems,
  onChange,
  onClose
}: {
  spec: WorkflowSpec
  step: WorkflowStep
  available: readonly WorkflowRoute[]
  models?: WorkflowSeatModelChoices
  /** With these, each agent gets the one model picker (every family, OpenRouter and Ollama). */
  sources?: readonly WorkflowModelSource[]
  modelDefaults?: WorkflowModelDefaults
  problems: WorkflowProblem[]
  onChange: (spec: WorkflowSpec) => void
  onClose: () => void
}) {
  const update = (patch: Partial<Omit<WorkflowStep, 'id'>>) =>
    onChange(workflowUpdateStep(spec, step.id, patch, available))
  const type = (patch: Partial<Pick<WorkflowStep, 'title' | 'instruction' | 'agents'>>) =>
    onChange(workflowPatchStep(spec, step.id, patch))
  const routes = available.filter(
    (route) =>
      localWorkflowRouteNamesModel(route) ||
      !workflowKindJudges(step.kind) ||
      workflowRouteMayJudge(route)
  )
  // A new agent starts on a family with a default model; OpenRouter and Ollama need one chosen.
  const seated = routes.filter((route) => !localWorkflowRouteNamesModel(route))
  const addable = seated.length ? seated : routes
  const allowed = workflowAllowedInputs(spec, step.id)
  const agentKeys = workflowAgentKeys(step.agents)
  const webRefusal = workflowWebRefusal(spec, step.id)
  const listInputs = step.inputs
    .map((id) => spec.steps.find((entry) => entry.id === id))
    .filter((entry): entry is WorkflowStep => !!entry?.list)
  return (
    <section
      aria-label={translate('workflowGraph.editor.label', 'Edit step')}
      className="space-y-3 rounded-lg border bg-card p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-medium">{step.title}</h4>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={translate('workflowGraph.editor.close', 'Close')}
          onClick={onClose}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      {problems.length > 0 && (
        <ul className="space-y-1 text-xs text-destructive">
          {problems.map((problem) => (
            <li key={problem.message}>{problem.message}</li>
          ))}
        </ul>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Field label={translate('workflowGraph.editor.title', 'Title')}>
          <Input value={step.title} onChange={(event) => type({ title: event.target.value })} />
        </Field>
        <Field label={translate('workflowGraph.editor.kind', 'Kind')}>
          <WorkflowSelect
            value={step.kind}
            options={KINDS.map((kind) => ({ value: kind, label: workflowKindLabel(kind) }))}
            onChange={(kind) => update({ kind: kind as WorkflowStepKind })}
          />
        </Field>
      </div>
      <p className="text-xs text-muted-foreground">{workflowKindHint(step.kind)}</p>
      <Field label={translate('workflowGraph.editor.instruction', 'What these agents do')}>
        <Textarea
          rows={3}
          value={step.instruction}
          placeholder={GRAPH_DEFAULT_INSTRUCTION_HINTS[step.kind]()}
          onChange={(event) => type({ instruction: event.target.value })}
        />
      </Field>
      <WorkflowJudgeFields
        spec={spec}
        step={step}
        onInstruction={(instruction) => type({ instruction })}
        onJev={(jev) => update({ jev })}
      />
      <div className="space-y-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          {translate('workflowGraph.editor.agents', 'Agents (run in parallel)')}
        </span>
        {step.agents.map((agent, index) => (
          <WorkflowAgentRow
            key={agentKeys[index]}
            agent={agent}
            judge={workflowKindJudges(step.kind)}
            routes={routes}
            models={models?.[agent.route]}
            sources={sources}
            modelDefaults={modelDefaults}
            onModel={(model) =>
              onChange(withWorkflowAgentModel(spec, step.id, index, model, modelDefaults))
            }
            canRemove={step.agents.length > 1}
            onRoute={(route) =>
              update({
                agents: step.agents.map((entry, position) =>
                  position === index
                    ? {
                        route,
                        ...(entry.angle ? { angle: entry.angle } : {}),
                        ...(entry.system ? { system: entry.system } : {})
                      }
                    : entry
                )
              })
            }
            onPatch={(patch) =>
              type({
                agents: step.agents.map((entry, position) =>
                  position === index ? { ...entry, ...patch } : entry
                )
              })
            }
            onRemove={() =>
              update({ agents: step.agents.filter((_, position) => position !== index) })
            }
          />
        ))}
        {step.kind !== 'synthesize' && step.agents.length < WORKFLOW_MAX_AGENTS_PER_STEP && (
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="gap-1"
            onClick={() =>
              update({
                agents: [
                  ...step.agents,
                  { route: addable[step.agents.length % Math.max(1, addable.length)] ?? 'claude' }
                ]
              })
            }
          >
            <Plus className="size-3" />
            {translate('workflowGraph.editor.addAgent', 'Add agent')}
          </Button>
        )}
      </div>
      {allowed.length > 0 && (
        <fieldset className="space-y-1">
          <legend className="text-xs font-medium text-muted-foreground">
            {translate('workflowGraph.editor.inputs', 'Reads the output of')}
          </legend>
          {allowed.map((input) => (
            <label key={input.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={step.inputs.includes(input.id)}
                onChange={(event) =>
                  update({
                    inputs: event.target.checked
                      ? [...step.inputs, input.id]
                      : step.inputs.filter((id) => id !== input.id)
                  })
                }
              />
              {input.title}
            </label>
          ))}
        </fieldset>
      )}
      {(step.kind === 'do' || step.kind === 'review') && listInputs.length > 0 && (
        <Field label={translate('workflowGraph.editor.runs', 'Runs')}>
          <WorkflowSelect
            value={step.forEach?.step ?? ''}
            options={[
              { value: '', label: translate('workflowGraph.editor.once', 'Once') },
              ...listInputs.map((input) => ({
                value: input.id,
                label: translate(
                  'workflowGraph.editor.forEach',
                  'Once for each item from {{step}}',
                  {
                    step: input.title
                  }
                )
              }))
            ]}
            onChange={(value) =>
              update(
                value
                  ? { forEach: { step: value, limit: step.forEach?.limit ?? 12 } }
                  : { forEach: undefined }
              )
            }
          />
        </Field>
      )}
      {step.kind === 'do' && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={!!step.list}
            onChange={(event) =>
              update({ list: event.target.checked ? { maxItems: 8 } : undefined })
            }
          />
          {translate(
            'workflowGraph.editor.list',
            'Returns a list of items for a later step to take one by one'
          )}
        </label>
      )}
      {/* A judge keeps its field only to remove pages it was given as a Do step. */}
      {(step.kind === 'do' || !!step.web?.urls.length) && (
        <WorkflowWebPagesField
          urls={step.web?.urls ?? []}
          others={spec.steps.flatMap((entry) =>
            entry.id === step.id ? [] : (entry.web?.urls ?? [])
          )}
          refusal={webRefusal ? workflowWebRefusalLabel(webRefusal) : undefined}
          onChange={(urls) => onChange(withWebPages(spec, step.id, urls))}
        />
      )}
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="gap-1 text-destructive"
        onClick={() => {
          onChange(workflowRemoveStep(spec, step.id, available))
          onClose()
        }}
      >
        <Trash2 className="size-3" />
        {translate('workflowGraph.editor.remove', 'Remove step')}
      </Button>
    </section>
  )
}
