import { WorkflowOpenRouterPicker } from './WorkflowOpenRouterPicker'
import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { WorkflowFindGitHubSearch } from './WorkflowFindGitHubSearch'
import { WorkflowFindList } from './WorkflowFindList'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  WORKFLOW_MAX_AGENTS_PER_STEP,
  WORKFLOW_MAX_RANK_CANDIDATES,
  type WorkflowRoute,
  type WorkflowSpec
} from '../../../../shared/workflow-graph'
import { parseReviewStepInstructions } from '../../../../shared/review-rubrics'
import { workflowPatchStep } from '../../../../shared/workflow-graph-edit'
import {
  findJudgeStep,
  findModelsOf,
  workflowSetFind
} from '../../../../shared/workflow-graph-find'
import {
  workflowJevFor,
  workflowJudgesOf,
  type WorkflowJudges
} from '../../../../shared/workflow-graph-improve'
import { WORKFLOW_ROUTE_NAMES } from './WorkflowAgentRow'
import { workflowJudgesHint, workflowJudgesOptions } from './WorkflowJudgeFields'
import { WorkflowRubricFields } from './WorkflowRubricFields'
import { WorkflowSelect } from './workflow-graph-controls'

const COUNTS = [20, 50, 100, 150]
const VERSION_COUNTS = Array.from({ length: WORKFLOW_MAX_AGENTS_PER_STEP - 1 }, (_, n) => n + 2)
const KEEPS = [5, 10, 20, 50, 100]

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

/**
 * Find the best's settings, all optional and folded away: where the options come from, how many
 * come back, what good means, and who judges the final. JEV always screens, so judges that leave
 * JEV out are not offered.
 */
export function WorkflowFindOptions({
  spec,
  available,
  onChange,
  onCustomize
}: {
  spec: WorkflowSpec
  available: readonly WorkflowRoute[]
  onChange: (spec: WorkflowSpec) => void
  onCustomize: () => void
}) {
  const [open, setOpen] = useState(false)
  const find = spec.find!
  const judge = findJudgeStep(spec)!
  const models = findModelsOf(spec)!
  const judges = workflowJudgesOf(judge.jev)
  const rubricName = parseReviewStepInstructions(judge.instruction).shared?.name
  const listed = find.items !== undefined
  const source = listed ? 'list' : find.versions ? 'versions' : 'generate'
  const given = (find.items ?? []).filter((item) => item.trim()).length
  // Reunites titles with their detail/url for display; onChange still writes the split shape.
  const listItems = (find.items ?? []).map((title, index) => {
    const extra = find.itemDetails?.[index]
    return extra?.detail || extra?.url
      ? {
          title,
          ...(extra.detail ? { detail: extra.detail } : {}),
          ...(extra.url ? { url: extra.url } : {})
        }
      : title
  })
  const keep = find.keep ?? find.top
  const summary = [
    listed
      ? translate('workflowGraph.find.listSummary', '{{count}} of your options', { count: given })
      : find.versions
        ? translate('workflowGraph.find.versionsSummary', '{{count}} complete versions', {
            count: find.count
          })
        : translate('workflowGraph.find.countSummary', '{{count}} options', { count: find.count }),
    translate('workflowGraph.find.keepSummary', 'bring back {{count}}', { count: keep }),
    translate('workflowGraph.find.finalSummary', '{{count}} in the final', { count: find.top }),
    ...(rubricName ? [rubricName] : []),
    ...(find.check ? [translate('workflowGraph.improve.checkSummary', 'checked')] : []),
    judges === 'both'
      ? translate('workflowGraph.improve.bothSummary', 'JEV + models judge')
      : translate('workflowGraph.improve.jevSummary', 'JEV judges')
  ].join(' · ')
  const set = (change: Parameters<typeof workflowSetFind>[1]) =>
    onChange(workflowSetFind(spec, change, available))
  const bringBack = (
    <Field label={translate('workflowGraph.find.bringBack', 'Bring back')}>
      <WorkflowSelect
        value={String(keep)}
        options={[...new Set([...KEEPS, keep])]
          .sort((left, right) => left - right)
          .map((count) => ({ value: String(count), label: String(count) }))}
        onChange={(value) => set({ keep: Number(value) })}
      />
    </Field>
  )
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
  // An Ollama seat names an installed model: that is chosen on the Models card, not here.
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
          <Field label={translate('workflowGraph.find.source', 'Options come from')}>
            <WorkflowSelect
              value={source}
              options={[
                {
                  value: 'generate',
                  label: translate('workflowGraph.find.generate', 'The models come up with them')
                },
                {
                  value: 'versions',
                  label: translate(
                    'workflowGraph.find.versions',
                    'Each model writes a complete version'
                  )
                },
                { value: 'list', label: translate('workflowGraph.find.list', 'My own list') }
              ]}
              onChange={(value) =>
                set(
                  value === 'list' ? { items: [] } : { items: null, versions: value === 'versions' }
                )
              }
            />
          </Field>
          {listed ? (
            bringBack
          ) : (
            <Field label={translate('workflowGraph.find.howMany', 'How many')}>
              <WorkflowSelect
                value={String(find.count)}
                options={[...new Set([...(find.versions ? VERSION_COUNTS : COUNTS), find.count])]
                  .sort((left, right) => left - right)
                  .map((count) => ({ value: String(count), label: String(count) }))}
                onChange={(value) => set({ count: Number(value) })}
              />
            </Field>
          )}
          {listed ? (
            <WorkflowFindList
              items={listItems}
              onChange={(items, importReceipt) => set({ items, importReceipt })}
            />
          ) : (
            <>
              {bringBack}
              <Field label={translate('workflowGraph.improve.models', 'Models')}>
                {models.mode === 'single' && models.route === 'openrouter' && (
                  <WorkflowOpenRouterPicker
                    model={models.model}
                    onChange={(model) =>
                      set({ models: { mode: 'single', route: 'openrouter', model } })
                    }
                  />
                )}
                <WorkflowSelect
                  value={models.mode === 'multi' ? 'multi' : models.route}
                  options={[
                    ...selectable.map((route) => ({
                      value: route,
                      label: WORKFLOW_ROUTE_NAMES[route]
                    })),
                    ...(available.length > 1
                      ? [
                          {
                            value: 'multi',
                            label: translate('workflowGraph.improve.multi', 'Multi-model')
                          }
                        ]
                      : [])
                  ]}
                  onChange={(value) =>
                    set({
                      models:
                        value === 'multi'
                          ? { mode: 'multi' }
                          : { mode: 'single', route: value as WorkflowRoute }
                    })
                  }
                />
              </Field>
            </>
          )}
          {find.versions ? null : (
            <WorkflowFindGitHubSearch
              harvest={find.harvest}
              onChange={(harvest) => set({ harvest })}
            />
          )}
          {find.versions ? (
            <Field
              className="col-span-2"
              label={translate('workflowGraph.find.check', 'Check each version (optional)')}
            >
              <Input
                className="h-8 font-mono text-xs"
                value={find.check?.command ?? ''}
                placeholder={translate(
                  'workflowGraph.improve.checkPlaceholder',
                  'e.g. pnpm test   or   node bench.mjs {code}'
                )}
                onChange={(event) =>
                  set({ check: event.target.value.trim() ? { command: event.target.value } : null })
                }
              />
              <span className="font-normal">
                {translate(
                  'workflowGraph.find.checkHint',
                  'Runs in this workspace on every version, without a shell and without this app\'s keys. Exit 0 passes; a printed "SCORE: <number>" ranks, and passing and a higher score beat any judge. {candidate} is the version as a file, {code} its code. It may run code the models wrote, on this computer.'
                )}
              </span>
            </Field>
          ) : null}
          <WorkflowRubricFields
            id="find"
            instruction={judge.instruction}
            onInstruction={(instruction) =>
              onChange(workflowPatchStep(spec, judge.id, { instruction }))
            }
            placeholder={translate(
              'workflowGraph.find.goodMeansPlaceholder',
              'One criterion per line, for example:\n- Cheap to start\n- Fast to first revenue\n- Hard to copy'
            )}
            hint={translate(
              'workflowGraph.find.goodMeansHint',
              'JEV scores every option on each line; you also get the top ones for each line.'
            )}
          />
          <Field label={translate('workflowGraph.find.inFinal', 'In the final')}>
            <WorkflowSelect
              value={String(find.top)}
              options={Array.from({ length: WORKFLOW_MAX_RANK_CANDIDATES }, (_, index) => ({
                value: String(index + 1),
                label: String(index + 1)
              }))}
              onChange={(value) => set({ top: Number(value) })}
            />
          </Field>
          <Field label={translate('workflowGraph.find.finalJudges', 'Final judges')}>
            <WorkflowSelect
              value={judges}
              options={workflowJudgesOptions().filter((option) => option.value !== 'models')}
              onChange={(value) => setJudges(value as WorkflowJudges)}
            />
          </Field>
          <p className="col-span-2 -mt-1.5 font-normal text-muted-foreground">
            {translate(
              'workflowGraph.find.finalHint',
              'The best {{count}} by JEV score meet head to head for first place; every option and score is saved in the workspace.',
              { count: find.top }
            )}{' '}
            {workflowJudgesHint(judges)}
          </p>
          <div className="col-span-2">
            <Button type="button" variant="link" size="xs" className="px-0" onClick={onCustomize}>
              {translate('workflowGraph.find.customize', 'Customize steps and system prompts')}
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}
