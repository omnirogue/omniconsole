import { useEffect, useRef, useState } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import { workflowModelClient } from '@/lib/workflow-model-client'
import type { WorkflowRoute, WorkflowSpec } from '../../../../shared/workflow-graph'
import type {
  WorkflowModelDefaults,
  WorkflowModelTiers
} from '../../../../shared/workflow-model-tiers'
import type { WorkflowOpenRouterModel } from '../../../../shared/workflow-openrouter-models'
import { useWorkflowCompile } from './use-workflow-compile'
import {
  workflowModelLabel,
  workflowModelPlanCatalog,
  type WorkflowModelSource
} from './workflow-model-sources'

type Outcome =
  | { kind: 'done'; lines: { id: string; text: string }[]; assumptions: string[] }
  | { kind: 'same' }
  | { kind: 'error'; text: string }

/**
 * Say which models should run what, in plain words, and an agent sets it up: tiers, named
 * models, free or local ones, or a combo of providers on one step. Only models change; what
 * changed is read back step by step, with anything the agent assumed.
 */
export function WorkflowModelDescribe({
  worktreeId,
  spec,
  tiers,
  available,
  sources,
  defaults,
  onChange
}: {
  worktreeId: string
  spec: WorkflowSpec
  tiers: WorkflowModelTiers
  available: readonly WorkflowRoute[]
  sources: readonly WorkflowModelSource[]
  defaults: WorkflowModelDefaults
  onChange: (spec: WorkflowSpec) => void
}) {
  const { planModels, compiling, cancel } = useWorkflowCompile(worktreeId)
  const [text, setText] = useState('')
  const [outcome, setOutcome] = useState<Outcome>()
  // The plan comes back seconds later: it lands on the workflow as it is then, not as it was.
  const latest = useRef({ spec, onChange })
  useEffect(() => {
    latest.current = { spec, onChange }
  })
  const submit = async () => {
    const description = text.trim()
    if (!description || compiling) {
      return
    }
    setOutcome(undefined)
    let openrouter: WorkflowOpenRouterModel[] = []
    if (available.includes('openrouter')) {
      try {
        openrouter = (await workflowModelClient.models()).models
      } catch {
        // Without the catalog the agent can still use tiers and the other families.
      }
    }
    const result = await planModels({
      description,
      spec,
      context: {
        tiers,
        available,
        defaults,
        catalog: workflowModelPlanCatalog(sources, openrouter)
      }
    })
    if ('error' in result) {
      setOutcome({ kind: 'error', text: result.error })
      return
    }
    if (!result.changed.length) {
      setOutcome({ kind: 'same' })
      return
    }
    const planned = new Map(
      result.spec.steps
        .filter((step) => result.changed.includes(step.id))
        .map((step) => [step.id, step.agents])
    )
    // Only the models of the steps the plan changed: a task typed meanwhile, or another edit, stays.
    latest.current.onChange({
      ...latest.current.spec,
      steps: latest.current.spec.steps.map((step) =>
        planned.has(step.id) ? { ...step, agents: planned.get(step.id)! } : step
      )
    })
    setText('')
    setOutcome({
      kind: 'done',
      assumptions: result.assumptions,
      lines: result.spec.steps
        .filter((step) => planned.has(step.id))
        .map((step) => ({
          id: step.id,
          text: `${step.title}: ${step.agents.map((agent) => workflowModelLabel(agent, sources)).join(' · ')}`
        }))
    })
  }
  return (
    <div className="space-y-1.5">
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <Input
          className="h-8 flex-1 text-xs"
          value={text}
          disabled={compiling}
          aria-label={translate('workflowGraph.models.describe', 'Describe the models you want')}
          placeholder={translate(
            'workflowGraph.models.describePlaceholder',
            'Or say it: “cheap models for the research, frontier for the final answer, the finders on Claude, GPT, Grok and a free OpenRouter model”'
          )}
          onChange={(event) => setText(event.target.value)}
        />
        {compiling ? (
          <Button type="button" variant="outline" size="xs" className="gap-1" onClick={cancel}>
            <Loader2 className="size-3 animate-spin" />
            {translate('workflowGraph.describe.stop', 'Stop')}
          </Button>
        ) : (
          <Button type="submit" size="xs" className="gap-1" disabled={!text.trim()}>
            <Sparkles className="size-3" />
            {translate('workflowGraph.models.describeApply', 'Set up')}
          </Button>
        )}
      </form>
      {outcome?.kind === 'error' && (
        <p role="alert" className="text-xs text-destructive">
          {outcome.text}
        </p>
      )}
      {outcome?.kind === 'same' && (
        <p role="status" className="text-xs text-muted-foreground">
          {translate(
            'workflowGraph.models.describeSame',
            'The workflow already runs those models, so nothing changed.'
          )}
        </p>
      )}
      {outcome?.kind === 'done' && (
        <div role="status" className="space-y-0.5 text-xs text-muted-foreground">
          {outcome.lines.map((line) => (
            <p key={line.id}>{line.text}</p>
          ))}
          {outcome.assumptions.length > 0 && (
            <p>
              {translate('workflowGraph.describe.assumed', 'Assumed: {{list}}', {
                list: outcome.assumptions.join(' ')
              })}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
