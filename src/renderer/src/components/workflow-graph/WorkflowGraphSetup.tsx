import { WorkflowGraphStepSetup } from './WorkflowGraphStepSetup'
import { DiscoverCreditEstimateBadge } from '../discover/DiscoverCreditEstimateBadge'
import { useDiscoverCreditEstimate } from '../discover/use-discover-credit-estimate'
import type { DiscoverCreditPricing } from '../../../../shared/discover-credit-quote-ipc'
import { quickDiscoverWorkflow } from '../../../../shared/workflow-graph-quick-discover'
import { WorkflowStartProgress } from './WorkflowStartProgress'
import { WorkflowModelPresets } from './WorkflowModelPresets'
import { WorkflowModelsPanel } from './WorkflowModelsPanel'
import type { WorkflowModelSource } from './workflow-model-sources'
import { useWorkflowSetupModels } from './use-workflow-model-tiers'
import { useMemo, useState } from 'react'
import { Loader2, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import type { LocalWorkflowDraft } from '../../../../shared/local-workflow-draft'
import {
  WORKFLOW_ROUTES,
  type WorkflowRoute,
  type WorkflowSpec
} from '../../../../shared/workflow-graph'
import { normalizeWorkflowSpec } from '../../../../shared/workflow-graph-normalize'
import { planWorkflowCalls } from '../../../../shared/workflow-graph-topology'
import { validateWorkflowSpec } from '../../../../shared/workflow-graph-validate'
import { WorkflowDescribePanel } from './WorkflowDescribePanel'
import { useWorkflowCompile } from './use-workflow-compile'
import { WorkflowFindOptions } from './WorkflowFindOptions'
import { WorkflowDecideOptions } from './WorkflowDecideOptions'
import { WorkflowImproveOptions } from './WorkflowImproveOptions'
import { WorkflowMaxAgentsField, workflowMaxAgentsForStart } from './WorkflowMaxAgentsField'
import { WorkflowRunsOnSelect } from './WorkflowRunsOnSelect'
import type { WorkflowSeatModelChoices } from './workflow-seat-model-choices'
import { WorkflowWebSetup } from './WorkflowWebSetup'
import { workflowWebPrefill } from '../../../../shared/workflow-web-setup'
import { WorkflowContextAccess } from './WorkflowContextAccess'
import { WorkflowContextChips } from './WorkflowContextChips'
import { useWorkflowContextSources } from './use-workflow-context-sources'
import { workflowContextIncludesWorkspace } from '../../../../shared/workflow-context-start'

/**
 * One screen for every workflow before it runs: the graph (drawn exactly as it will run), the
 * step being edited, what is wrong with it, and the task. Templates open with their graph; a
 * custom workflow starts from a description. Run stays disabled while anything is invalid.
 */
export function WorkflowGraphSetup({
  worktreeId,
  draft,
  available,
  models,
  sources,
  unavailableReason,
  loading,
  recoveringStart,
  creditPricing,
  onChange,
  onStart
}: {
  worktreeId: string
  draft: LocalWorkflowDraft & { graph: NonNullable<LocalWorkflowDraft['graph']> }
  available: readonly WorkflowRoute[]
  /** Models each family's seat offers, for the agent model picker. */
  models?: WorkflowSeatModelChoices
  /** Every family the host seats with all its models: the Models card needs them. */
  sources?: readonly WorkflowModelSource[]
  unavailableReason?: string
  /** Still asking the host which models are available: said quietly, not as an error. */
  loading?: boolean
  recoveringStart?: boolean
  /** Current model credit rates supplied by the pricing provider; absent means unavailable. */
  creditPricing?: DiscoverCreditPricing
  onChange: (draft: LocalWorkflowDraft) => void
  onStart: (draft: LocalWorkflowDraft) => Promise<void>
}) {
  const [selected, setSelected] = useState<string>()
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState('')
  const [describing, setDescribing] = useState(draft.graph.spec.template === 'custom')
  const [customizing, setCustomizing] = useState(false)
  // Addresses the person removed from the pages: the request never offers them again.
  const [dismissedPages, setDismissedPages] = useState<ReadonlySet<string>>(() => new Set())
  const context = useWorkflowContextSources()
  const routes = available.length ? available : WORKFLOW_ROUTES
  const spec = draft.graph.spec
  const normalized = useMemo(() => normalizeWorkflowSpec(spec, routes), [spec, routes])
  const validation = useMemo(
    () => validateWorkflowSpec(normalized, { available: routes }),
    [normalized, routes]
  )
  const setSpec = (next: WorkflowSpec) =>
    onChange({ ...draft, graph: { ...draft.graph, spec: next } })
  const plannedCalls = planWorkflowCalls(normalized)
  const calls = plannedCalls.total
  const credits = useDiscoverCreditEstimate(worktreeId, draft, normalized, creditPricing)
  const { compile } = useWorkflowCompile(worktreeId)
  const { tierState, modelDefaults, compileModels } = useWorkflowSetupModels(sources)
  // With no steps yet, Run builds the workflow from the prompt first: a prompt is enough.
  const empty = normalized.steps.length === 0
  const ready = (empty || !validation.problems.length) && !!draft.prompt.trim()
  const start = async () => {
    if (!credits.allowed) {
      return
    }
    setStarting(true)
    setStartError('')
    try {
      // Refused before any workflow is built: with nothing to read there is nothing to run.
      context.forStart(draft)
      let spec = normalized
      let prompt = draft.prompt.trim()
      if (empty) {
        const built = await compile({
          description: prompt,
          available: routes,
          models: compileModels
        })
        if ('error' in built) {
          throw new Error(built.error)
        }
        prompt = built.task.trim() || prompt
        onChange({ ...draft, prompt, graph: { ...draft.graph, spec: built.spec } })
        if (built.validation.problems.length) {
          throw new Error(built.validation.problems[0]!.message)
        }
        spec = built.spec
        if (
          credits.requiresQuote &&
          (spec.template === 'discover' || spec.template === 'quick-discover')
        ) {
          throw new Error('Review the Discover credit estimate before launching.')
        }
      }
      // Sent only when set: a host without Max agents refuses a field it does not know.
      const { maxAgents: chosen, ...graph } = draft.graph
      const maxAgents = workflowMaxAgentsForStart(spec, planWorkflowCalls(spec).total, chosen)
      await onStart(
        context.forStart({
          ...draft,
          prompt,
          graph: { ...graph, spec, ...(maxAgents ? { maxAgents } : {}) }
        })
      )
    } catch (error) {
      setStartError(error instanceof Error ? error.message : String(error))
    } finally {
      setStarting(false)
    }
  }
  // Improve and Find the best open as a prompt and a Run button; options fold away until asked for.
  const simple =
    !customizing && normalized.template === 'improve' && normalized.repeat?.until === 'plateau'
  // Best of N keeps template 'best-of-n' for its own tab identity, but runs through the same
  // Find engine (spec.find is set either way); only a legacy Best of N spec with no find field
  // (from before the merge) falls back to the generic step editor.
  const finding = !customizing && !!normalized.find
  return (
    <div className="space-y-4">
      {sources && spec.steps.length > 0 ? (
        <WorkflowModelsPanel
          worktreeId={worktreeId}
          spec={spec}
          available={routes}
          sources={sources}
          defaults={modelDefaults}
          tierState={tierState}
          onChange={setSpec}
        />
      ) : (
        <WorkflowModelPresets spec={spec} onChange={setSpec} />
      )}
      {simple ? (
        describing ? (
          <WorkflowDescribePanel
            worktreeId={worktreeId}
            spec={normalized}
            available={routes}
            models={compileModels}
            onCompiled={(next) => onChange({ ...draft, graph: { ...draft.graph, spec: next } })}
          />
        ) : null
      ) : finding ? null : describing ? (
        <WorkflowDescribePanel
          worktreeId={worktreeId}
          spec={normalized.steps.length ? normalized : undefined}
          available={routes}
          models={compileModels}
          onCompiled={(next, task) => {
            onChange({
              ...draft,
              ...(task && !draft.prompt.trim() ? { prompt: task } : {}),
              graph: { ...draft.graph, spec: next }
            })
            setSelected(undefined)
          }}
        />
      ) : (
        <Button
          type="button"
          variant="link"
          size="xs"
          className="px-0"
          onClick={() => setDescribing(true)}
        >
          {translate('workflowGraph.setup.describeChange', 'Change this workflow by describing it')}
        </Button>
      )}
      {!customizing && normalized.template === 'decide' && (
        <WorkflowDecideOptions spec={spec} available={routes} onChange={setSpec} />
      )}
      {!simple && !finding && normalized.steps.length > 0 && (
        <WorkflowGraphStepSetup
          spec={spec}
          normalized={normalized}
          routes={routes}
          selected={selected}
          models={models}
          sources={sources}
          modelDefaults={modelDefaults}
          validation={validation}
          agentTotal={plannedCalls.agentTotal}
          onSelect={setSelected}
          onChange={setSpec}
        />
      )}
      <section className="space-y-2 rounded-xl border bg-card p-3">
        <Textarea
          rows={3}
          value={draft.prompt}
          aria-label={translate('workflowGraph.setup.task', 'What should the workflow work on?')}
          placeholder={
            finding
              ? normalized.find?.versions
                ? translate(
                    'workflowGraph.setup.findVersionsPlaceholder',
                    'What should each model write in full? For example: the opening paragraph of our landing page, or a reply to this customer.'
                  )
                : translate(
                    'workflowGraph.setup.findPlaceholder',
                    'What are you looking for? For example: business ideas for a small bakery, or the best open-source job queue for Node.'
                  )
              : simple
                ? translate(
                    'workflowGraph.setup.improvePlaceholder',
                    'What should get better? Build, research, solve or design something, or paste work to improve.'
                  )
                : translate(
                    'workflowGraph.setup.taskPlaceholder',
                    'What should the workflow work on? The question, the goal or the task.'
                  )
          }
          onChange={(event) => onChange({ ...draft, prompt: event.target.value })}
          // Offered once the person stops typing here, so a half-typed address is never taken.
          onBlur={() => {
            const next = workflowWebPrefill(spec, draft.prompt, dismissedPages)
            const contextSources = context.prefill(draft)
            if (next || contextSources) {
              onChange({
                ...draft,
                ...(next ? { graph: { ...draft.graph, spec: next } } : {}),
                ...(contextSources ? { contextSources } : {})
              })
            }
          }}
        />
        <WorkflowContextChips
          sources={draft.access === 'frozen' ? [] : (draft.contextSources ?? [])}
          includesWorkspace={workflowContextIncludesWorkspace(draft)}
          onRemove={(source) => onChange(context.remove(draft, source))}
        />
        {credits.enabled && (
          <DiscoverCreditEstimateBadge
            quote={credits.quote}
            guard={credits.guard}
            loading={credits.loading}
            onTopUpCredits={() => {
              void window.api.omnirogue?.credits.openTopUp()
            }}
            onConnectOmniRogue={async () => {
              await window.api.omnirogue?.account.startConnect()
              credits.refresh()
            }}
            onSwitchToQuick={() =>
              setSpec(normalizeWorkflowSpec(quickDiscoverWorkflow(routes), routes))
            }
          />
        )}
        {credits.enabled && credits.unavailableReason && (
          <p role="status" className="text-xs text-muted-foreground">
            {credits.unavailableReason}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <WorkflowContextAccess
            worktreeId={worktreeId}
            draft={draft}
            onChange={onChange}
            onRemove={(source) => onChange(context.remove(draft, source))}
          />
          <WorkflowMaxAgentsField
            spec={normalized}
            planned={calls}
            value={draft.graph.maxAgents}
            onChange={(maxAgents) => onChange({ ...draft, graph: { ...draft.graph, maxAgents } })}
          />
          <WorkflowRunsOnSelect draft={draft} onChange={onChange} />
          <Button
            type="button"
            size="sm"
            className="ml-auto gap-1.5"
            disabled={
              !ready || !credits.allowed || starting || recoveringStart || !!unavailableReason
            }
            onClick={() => void start()}
          >
            {starting || recoveringStart ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Play className="size-3.5" />
            )}
            {translate('workflowGraph.setup.run', 'Run')}
          </Button>
        </div>
        <WorkflowStartProgress active={starting || !!recoveringStart} />
        {empty && !startError ? (
          <p className="text-xs text-muted-foreground">
            {translate(
              'workflowGraph.setup.buildFromPrompt',
              'No steps yet: Run first builds a workflow from what you typed, then runs it.'
            )}
          </p>
        ) : null}
        {startError || (unavailableReason && !loading) ? (
          <p role="alert" className="text-xs text-destructive">
            {startError || unavailableReason}
          </p>
        ) : unavailableReason ? (
          <p role="status" className="text-xs text-muted-foreground">
            {unavailableReason}
          </p>
        ) : null}
      </section>
      <WorkflowWebSetup
        spec={spec}
        prompt={draft.prompt}
        dismissed={dismissedPages}
        onDismiss={(urls) => setDismissedPages(new Set([...dismissedPages, ...urls]))}
        onChange={setSpec}
      />
      {finding && (
        <>
          <WorkflowFindOptions
            spec={spec}
            available={routes}
            onChange={setSpec}
            onCustomize={() => setCustomizing(true)}
          />
          {validation.problems.slice(0, 2).map((problem) => (
            <p key={problem.message} role="alert" className="text-xs text-destructive">
              {problem.message}
            </p>
          ))}
        </>
      )}
      {simple && (
        <>
          <WorkflowImproveOptions
            spec={spec}
            available={routes}
            onChange={setSpec}
            onCustomize={() => setCustomizing(true)}
            onDescribe={() => setDescribing(true)}
          />
          {validation.problems.slice(0, 2).map((problem) => (
            <p key={problem.message} role="alert" className="text-xs text-destructive">
              {problem.message}
            </p>
          ))}
        </>
      )}
    </div>
  )
}
