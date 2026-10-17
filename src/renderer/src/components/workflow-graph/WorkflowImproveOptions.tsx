import { WorkflowOpenRouterPicker } from './WorkflowOpenRouterPicker'
import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  WORKFLOW_MAX_IMPROVE_ROUNDS,
  WORKFLOW_MAX_PATIENCE,
  type WorkflowExplore,
  type WorkflowRoute,
  type WorkflowSpec
} from '../../../../shared/workflow-graph'
import { workflowPatchStep, workflowSetRepeat } from '../../../../shared/workflow-graph-edit'
import {
  IMPROVE_MAX_CANDIDATES,
  fastImproveModels,
  improveModelsOf,
  improveStep,
  isFastImproveModels,
  workflowJevFor,
  workflowJudgesOf,
  workflowSetImprove,
  type WorkflowJudges
} from '../../../../shared/workflow-graph-improve'
import { parseReviewStepInstructions } from '../../../../shared/review-rubrics'
import { WORKFLOW_ROUTE_NAMES } from './WorkflowAgentRow'
import { WorkflowImprovePopulationField } from './WorkflowImprovePopulationField'
import { WorkflowImprovePromptsField } from './WorkflowImprovePromptsField'
import { WorkflowImproveTestFields, workflowImproveTestSummary } from './WorkflowImproveTestFields'
import { WorkflowRubricFields } from './WorkflowRubricFields'
import { workflowJudgesHint, workflowJudgesOptions } from './WorkflowJudgeFields'
import { WorkflowSelect } from './workflow-graph-controls'

function Field({
  label,
  className,
  children
}: {
  label: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <label
      className={cn('flex flex-col gap-1 text-xs font-medium text-muted-foreground', className)}
    >
      {label}
      {children}
    </label>
  )
}

const range = (count: number) =>
  Array.from({ length: count }, (_, index) => String(index + 1)).map((value) => ({
    value,
    label: value
  }))

/**
 * Improve's settings, all optional and folded away: a one-line summary says what will happen,
 * and opening it offers models, candidates, rounds, exploration, judges and what good means.
 */
export function WorkflowImproveOptions({
  spec,
  available,
  onChange,
  onCustomize,
  onDescribe
}: {
  spec: WorkflowSpec
  available: readonly WorkflowRoute[]
  onChange: (spec: WorkflowSpec) => void
  onCustomize: () => void
  onDescribe: () => void
}) {
  const [open, setOpen] = useState(false)
  const repeat = spec.repeat!
  const step = improveStep(spec)!
  const judge = spec.steps.find((entry) => entry.id === repeat.review)!
  const models = improveModelsOf(spec)!
  const isFast = isFastImproveModels(models)
  const judges = workflowJudgesOf(judge.jev)
  const rubric = parseReviewStepInstructions(judge.instruction)
  const summary = [
    models.mode === 'single'
      ? WORKFLOW_ROUTE_NAMES[models.route]
      : isFast
        ? translate('workflowGraph.improve.fastSummary', 'Fast OpenEvolve (Haiku 5.5 + Flash)')
        : translate('workflowGraph.improve.multi', 'Multi-model'),
    translate('workflowGraph.improve.candidatesSummary', '{{count}} a round', {
      count: step.agents.length
    }),
    repeat.maxRounds === 1
      ? translate('workflowGraph.improve.roundsSummary_one', 'up to {{count}} round', {
          count: repeat.maxRounds
        })
      : translate('workflowGraph.improve.roundsSummary_other', 'up to {{count}} rounds', {
          count: repeat.maxRounds
        }),
    ...(rubric.shared ? [rubric.shared.name] : []),
    ...workflowImproveTestSummary(repeat.check),
    ...(repeat.prompts ? [translate('workflowGraph.improve.promptsSummary', 'own prompts')] : []),
    judges === 'jev'
      ? translate('workflowGraph.improve.jevSummary', 'JEV judges')
      : judges === 'both'
        ? translate('workflowGraph.improve.bothSummary', 'JEV + models judge')
        : translate('workflowGraph.improve.modelsSummary', 'models judge')
  ].join(' · ')
  const setRepeat = (patch: Partial<typeof repeat>) =>
    onChange(workflowSetRepeat(spec, { ...repeat, ...patch }, available))
  const setJudges = (value: WorkflowJudges) => {
    const { jev: _previous, ...rest } = judge
    const jev = workflowJevFor(value, judge.jev)
    onChange({
      ...spec,
      steps: spec.steps.map((entry) =>
        entry.id === judge.id ? (jev ? { ...rest, jev } : rest) : entry
      )
    })
  }
  const selectable = available.filter((route) => route !== 'ollama')
  return (
    <section className="rounded-xl border bg-card p-3 text-xs">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 text-left"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <ChevronRight
          aria-hidden="true"
          className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')}
        />
        <span className="font-medium">{translate('workflowGraph.improve.options', 'Options')}</span>
        <span className="truncate text-muted-foreground">{summary}</span>
      </button>
      {open && (
        <div className="mt-3 grid grid-cols-2 gap-3">
          <Field label={translate('workflowGraph.improve.models', 'Models')}>
            {models.mode === 'single' && models.route === 'openrouter' && (
              <WorkflowOpenRouterPicker
                model={models.model}
                onChange={(model) =>
                  onChange(
                    workflowSetImprove(
                      spec,
                      { models: { mode: 'single', route: 'openrouter', model } },
                      available
                    )
                  )
                }
              />
            )}
            <WorkflowSelect
              value={models.mode === 'single' ? models.route : isFast ? 'fast' : 'multi'}
              options={[
                ...selectable.map((route) => ({
                  value: route,
                  label: WORKFLOW_ROUTE_NAMES[route]
                })),
                {
                  value: 'fast',
                  label: translate(
                    'workflowGraph.improve.fastOption',
                    'Fast OpenEvolve (Haiku 5.5 + Gemini Flash + Luna)'
                  )
                },
                {
                  value: 'multi',
                  label: translate(
                    'workflowGraph.improve.multiOption',
                    'Multi-model (rotate families)'
                  )
                }
              ]}
              onChange={(value) =>
                onChange(
                  workflowSetImprove(
                    spec,
                    {
                      models:
                        value === 'fast'
                          ? fastImproveModels(available)
                          : value === 'multi'
                            ? { mode: 'multi' }
                            : { mode: 'single', route: value as WorkflowRoute }
                    },
                    available
                  )
                )
              }
            />
          </Field>
          <Field label={translate('workflowGraph.improve.candidates', 'Candidates per round')}>
            <WorkflowSelect
              value={String(step.agents.length)}
              options={range(IMPROVE_MAX_CANDIDATES)}
              onChange={(value) =>
                onChange(workflowSetImprove(spec, { candidates: Number(value) }, available))
              }
            />
          </Field>
          <Field label={translate('workflowGraph.improve.rounds', 'Rounds, at most')}>
            <WorkflowSelect
              value={String(repeat.maxRounds)}
              options={range(WORKFLOW_MAX_IMPROVE_ROUNDS)}
              onChange={(value) => setRepeat({ maxRounds: Number(value) })}
            />
          </Field>
          <Field
            label={translate('workflowGraph.improve.patience', 'Stop after rounds without gain')}
          >
            <WorkflowSelect
              value={String(repeat.patience ?? 2)}
              options={range(WORKFLOW_MAX_PATIENCE)}
              onChange={(value) => setRepeat({ patience: Number(value) })}
            />
          </Field>
          <Field
            className="col-span-2"
            label={translate('workflowGraph.improve.explore', 'Exploration')}
          >
            <WorkflowSelect
              value={repeat.explore ?? 'normal'}
              options={[
                {
                  value: 'low',
                  label: translate(
                    'workflowGraph.improve.exploreLow',
                    'Low: only refine the best version'
                  )
                },
                {
                  value: 'normal',
                  label: translate(
                    'workflowGraph.improve.exploreNormal',
                    'Normal: try a different approach before giving up'
                  )
                },
                {
                  value: 'high',
                  label: translate(
                    'workflowGraph.improve.exploreHigh',
                    'High: half the candidates explore different approaches'
                  )
                }
              ]}
              onChange={(value) => setRepeat({ explore: value as WorkflowExplore })}
            />
          </Field>
          <WorkflowImproveTestFields
            check={repeat.check}
            onChange={(check) => {
              const { check: _previous, ...rest } = repeat
              onChange({ ...spec, repeat: check ? { ...rest, check } : rest })
            }}
          />
          <WorkflowImprovePopulationField spec={spec} available={available} onChange={onChange} />
          <Field className="col-span-2" label={translate('workflowGraph.editor.judges', 'Judges')}>
            <WorkflowSelect
              value={judges}
              options={workflowJudgesOptions()}
              onChange={(value) => setJudges(value as WorkflowJudges)}
            />
            <span className="font-normal">{workflowJudgesHint(judges)}</span>
          </Field>
          <WorkflowRubricFields
            id="improve"
            instruction={judge.instruction}
            onInstruction={(instruction) =>
              onChange(workflowPatchStep(spec, judge.id, { instruction }))
            }
            placeholder={translate(
              'workflowGraph.improve.goodMeansPlaceholder',
              'One criterion per line, for example:\n- Clear to a first-time reader\n- Every claim backed by evidence'
            )}
            hint={translate(
              'workflowGraph.improve.goodMeansHint',
              'The judges and JEV use this; JEV scores each bulleted line on its own.'
            )}
          />
          <Field
            className="col-span-2"
            label={translate(
              'workflowGraph.improve.instruction',
              'Improvement instruction (optional)'
            )}
          >
            <Textarea
              rows={2}
              className="text-xs"
              value={step.instruction}
              placeholder={translate(
                'workflowGraph.improve.instructionPlaceholder',
                'Anything every version must follow, e.g. "Keep it under 200 words."'
              )}
              onChange={(event) =>
                onChange(workflowPatchStep(spec, step.id, { instruction: event.target.value }))
              }
            />
          </Field>
          <div className="col-span-2">
            <WorkflowImprovePromptsField
              prompts={repeat.prompts}
              onChange={(prompts) => {
                const { prompts: _previous, ...rest } = repeat
                onChange({ ...spec, repeat: prompts ? { ...rest, prompts } : rest })
              }}
            />
          </div>
          <div className="col-span-2 flex flex-wrap gap-3">
            <Button type="button" variant="link" size="xs" className="px-0" onClick={onDescribe}>
              {translate('workflowGraph.improve.describe', 'Change it by describing it')}
            </Button>
            <Button type="button" variant="link" size="xs" className="px-0" onClick={onCustomize}>
              {translate('workflowGraph.improve.customize', 'Customize seats and system prompts')}
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}
