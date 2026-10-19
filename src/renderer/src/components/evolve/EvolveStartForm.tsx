import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import {
  titleLocalWorkflowConversation,
  updateLocalWorkflowConversation
} from '@/lib/local-workflow-conversation'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  EVOLVE_DEFAULT_CHECKOUT,
  EVOLVE_RPC,
  type EvolveRunRecord,
  type HostedEvolveExecutionTier
} from '../../../../shared/evolve-workflow'
import {
  createEvolveDraft,
  estimateHostedEvolveCredits,
  evolveStartRequestFromDraft,
  findBestLocalWinnerSeed,
  type EvolveDraft
} from '../../../../shared/evolve-workflow-draft'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { BuildReviewSetupRow } from '../build-review/BuildReviewSetupRow'
import { withWorkflowRunOnChoice } from '../local-workflows/workflow-run-on-hosts'
import { WorkflowSelect } from '../workflow-graph/workflow-graph-controls'
import { WorkflowRunOnPicker } from '../workflow-graph/WorkflowRunsOnSelect'
import { EvolveExecutionModeSection } from './EvolveExecutionModeSection'
import { EvolveWarmStartModal } from './EvolveWarmStartModal'
import { findEvolveWarmStartWinner } from './evolve-warm-start-helpers'
import { callEvolveRun, useEvolveRuns } from './use-evolve-run'

type TextField = Exclude<
  keyof EvolveDraft,
  | 'target'
  | 'runsOn'
  | 'runsOnHost'
  | 'runsOnHostId'
  | 'executionTier'
  | 'estimatedCredits'
  | 'seedFromRunId'
>

function targetOptions() {
  return [
    {
      value: 'email-smoke',
      label: translate('evolve.target.emailSmoke', 'Email replies — synthetic seat smoke')
    },
    { value: 'email', label: translate('evolve.target.email', 'Email replies') },
    { value: 'ads', label: translate('evolve.target.ads', 'Ads') },
    { value: 'spec', label: translate('evolve.target.spec', 'A spec path') }
  ]
}

function fieldLabel(field: string): string {
  switch (field) {
    case 'target':
      return translate('evolve.field.target', 'Target')
    case 'runsOn':
      return translate('evolve.field.runsOn', 'Run on')
    case 'specPath':
      return translate('evolve.field.specPath', 'Spec path')
    case 'checkout':
      return translate('evolve.field.checkout', 'jev-lab checkout')
    case 'iterations':
      return translate('evolve.field.iterations', 'Iterations')
    case 'patience':
      return translate('evolve.field.patience', 'Patience (plateau stop)')
    case 'seedFrom':
      return translate('evolve.field.seedFrom', 'Seed from')
    case 'rubricFrom':
      return translate('evolve.field.rubricFrom', 'Rubric from')
    case 'usdCap':
      return translate('evolve.field.usdCap', 'Budget cap (USD)')
    case 'submittedBy':
      return translate('evolve.field.submittedBy', 'Submitted by')
    default:
      return field
  }
}

function Hint({ children }: { children: string }) {
  return <p className="text-xs text-muted-foreground">{children}</p>
}

/** The Evolve setup: saved to the tab as typed, validated by the RPC's own schema before Start. */
export function EvolveStartForm({ tab }: { tab: TerminalTab }) {
  const [draft, setDraft] = useState<EvolveDraft>(
    () => tab.localWorkflow?.evolveDraft ?? createEvolveDraft()
  )
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [warmStartOpen, setWarmStartOpen] = useState(false)
  const runsById = useEvolveRuns((state) => state.runsById)

  useEffect(() => {
    let active = true
    void callRuntimeRpc<{ runs: EvolveRunRecord[] }>({ kind: 'local' }, EVOLVE_RPC.list, {})
      .then(({ runs }) => {
        if (!active || !Array.isArray(runs)) {
          return
        }
        const put = useEvolveRuns.getState().put
        for (const run of runs) {
          put(run)
        }
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])

  const bestLocalWinner = useMemo(
    () => findBestLocalWinnerSeed(Object.values(runsById), draft.target),
    [runsById, draft.target]
  )

  const runs = useMemo(() => Object.values(runsById), [runsById])
  const hasWarmStartWinner = useMemo(
    () => Boolean(findEvolveWarmStartWinner(runs, { ...draft, worktreeId: tab.worktreeId })),
    [runs, draft, tab.worktreeId]
  )

  const isHosted = draft.runsOn === 'hosted'
  const hostedTier: HostedEvolveExecutionTier =
    draft.executionTier === 'hosted_pro' ? 'hosted_pro' : 'hosted_super_intelligence'
  const hostedQuote = useMemo(
    () =>
      estimateHostedEvolveCredits({
        executionTier: hostedTier,
        iterations: draft.iterations,
        target: draft.target
      }),
    [hostedTier, draft.iterations, draft.target]
  )

  const change = (next: EvolveDraft) => {
    const normalized: EvolveDraft =
      next.runsOn === 'hosted'
        ? {
            ...next,
            executionTier:
              next.executionTier === 'hosted_pro' ? 'hosted_pro' : 'hosted_super_intelligence',
            estimatedCredits: estimateHostedEvolveCredits({
              executionTier:
                next.executionTier === 'hosted_pro' ? 'hosted_pro' : 'hosted_super_intelligence',
              iterations: next.iterations,
              target: next.target
            }).estimatedCredits
          }
        : { ...next, executionTier: 'local', estimatedCredits: undefined, seedFromRunId: undefined }
    setDraft(normalized)
    setError(null)
    updateLocalWorkflowConversation(tab.worktreeId, tab.id, { evolveDraft: normalized })
  }

  const selectExecutionMode = (mode: 'local_or_fleet' | 'hosted') => {
    if (mode === 'hosted') {
      const autoSeed = draft.seedFrom.trim() || bestLocalWinner?.seedValue || draft.target
      change({
        ...draft,
        runsOn: 'hosted',
        executionTier:
          draft.executionTier === 'hosted_pro' ? 'hosted_pro' : 'hosted_super_intelligence',
        seedFrom: autoSeed,
        seedFromRunId: bestLocalWinner?.runId
      })
      return
    }
    change({
      ...draft,
      runsOn: draft.runsOn === 'hosted' ? 'fleet' : (draft.runsOn ?? 'fleet'),
      executionTier: 'local'
    })
  }

  const selectHostedTier = (tier: HostedEvolveExecutionTier) => {
    change({
      ...draft,
      runsOn: 'hosted',
      executionTier: tier
    })
  }

  const rowId = (field: string) => `evolve-${tab.id}-${field}`
  const input = (field: TextField, placeholder?: string) => (
    <Input
      id={rowId(field)}
      className="h-8 text-xs"
      value={draft[field] ?? ''}
      placeholder={placeholder}
      onChange={(event) => change({ ...draft, [field]: event.target.value })}
    />
  )
  // Resolves false when the request is invalid or the start fails; the reason is shown below the form.
  const start = async (source: EvolveDraft = draft): Promise<boolean> => {
    const parsed = evolveStartRequestFromDraft(source, {
      conversationId: tab.id,
      worktreeId: tab.worktreeId
    })
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const field = issue?.path[0]
      setError(
        field === undefined
          ? (issue?.message ?? '')
          : translate('evolve.invalidField', '{{field}}: {{problem}}', {
              field: fieldLabel(String(field)),
              problem: issue?.message ?? ''
            })
      )
      return false
    }
    setPending(true)
    setError(null)
    try {
      const run = await callEvolveRun(EVOLVE_RPC.start, parsed.data)
      const prompt = translate('evolve.prompt', 'Evolve {{target}} on {{host}}', {
        target: parsed.data.target === 'spec' ? (parsed.data.specPath ?? '') : parsed.data.target,
        host: run.host
      })
      updateLocalWorkflowConversation(tab.worktreeId, tab.id, { executionId: run.id, prompt })
      titleLocalWorkflowConversation(tab.id, prompt)
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return false
    } finally {
      setPending(false)
    }
  }
  const warmStart = async (next: EvolveDraft) => {
    change(next)
    if (!(await start(next))) {
      throw new Error('Warm start did not begin')
    }
  }
  return (
    <>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          void start()
        }}
      >
        <fieldset disabled={pending} className="space-y-3">
          <EvolveExecutionModeSection
            tabId={tab.id}
            isHosted={isHosted}
            hostedTier={hostedTier}
            hostedQuote={hostedQuote}
            onSelectMode={selectExecutionMode}
            onSelectTier={selectHostedTier}
          />
          <BuildReviewSetupRow labelId={rowId('target-label')} label={fieldLabel('target')}>
            <WorkflowSelect
              className="w-72"
              value={draft.target}
              options={targetOptions()}
              onChange={(target) => {
                const nextTarget = target as EvolveDraft['target']
                const nextWinner = findBestLocalWinnerSeed(Object.values(runsById), nextTarget)
                change({
                  ...draft,
                  target: nextTarget,
                  ...(isHosted
                    ? {
                        seedFrom:
                          nextWinner?.seedValue ??
                          (nextTarget === 'spec' ? draft.seedFrom : nextTarget),
                        seedFromRunId: nextWinner?.runId
                      }
                    : {})
                })
              }}
            />
          </BuildReviewSetupRow>
          {draft.target === 'spec' && (
            <BuildReviewSetupRow htmlFor={rowId('specPath')} label={fieldLabel('specPath')}>
              {input('specPath', 'jevlab/evolve/…/evolve.yaml')}
              <Hint>
                {translate('evolve.hint.specPath', 'A .yaml path relative to the checkout.')}
              </Hint>
            </BuildReviewSetupRow>
          )}
          {!isHosted && (
            <BuildReviewSetupRow htmlFor={rowId('checkout')} label={fieldLabel('checkout')}>
              {input('checkout', EVOLVE_DEFAULT_CHECKOUT)}
              <Hint>
                {translate(
                  'evolve.hint.checkout',
                  'A checkout only Evolve workers use; see jev-lab docs/evolve-hosts.md.'
                )}
              </Hint>
            </BuildReviewSetupRow>
          )}
          <BuildReviewSetupRow htmlFor={rowId('iterations')} label={fieldLabel('iterations')}>
            {input('iterations', translate('evolve.placeholder.iterations', 'the spec’s'))}
          </BuildReviewSetupRow>
          <BuildReviewSetupRow htmlFor={rowId('patience')} label={fieldLabel('patience')}>
            {input('patience', translate('evolve.placeholder.patience', 'the spec’s (default 4)'))}
            <Hint>
              {translate(
                'evolve.hint.patience',
                'Stops early when N consecutive mutations fail to improve the best score.'
              )}
            </Hint>
          </BuildReviewSetupRow>
          <BuildReviewSetupRow htmlFor={rowId('seedFrom')} label={fieldLabel('seedFrom')}>
            {input('seedFrom', translate('evolve.placeholder.seedFrom', 'a target id'))}
            <Hint>
              {isHosted
                ? translate(
                    'evolveHosted.blindAuditGuarantee',
                    'Beats your local winner in blind cross-family audit before promoting'
                  )
                : translate(
                    'evolve.hint.seedFrom',
                    "Loads the target's best earlier and promoted candidates, re-evaluated on this run's data."
                  )}
            </Hint>
          </BuildReviewSetupRow>
          <BuildReviewSetupRow htmlFor={rowId('rubricFrom')} label={fieldLabel('rubricFrom')}>
            {input('rubricFrom', translate('evolve.placeholder.rubricFrom', 'a rubric sha256'))}
          </BuildReviewSetupRow>
          <BuildReviewSetupRow htmlFor={rowId('usdCap')} label={fieldLabel('usdCap')}>
            {input('usdCap', translate('evolve.placeholder.usdCap', 'the spec’s'))}
            <Hint>
              {translate(
                'evolve.hint.usdCap',
                "Lowers this run's cap; never above the spec's group cap."
              )}
            </Hint>
          </BuildReviewSetupRow>
          <BuildReviewSetupRow htmlFor={rowId('submittedBy')} label={fieldLabel('submittedBy')}>
            {input(
              'submittedBy',
              translate('evolve.placeholder.submittedBy', 'this computer’s user')
            )}
          </BuildReviewSetupRow>
          {!isHosted && (
            <BuildReviewSetupRow labelId={rowId('runs-on-label')} label={fieldLabel('runsOn')}>
              <WorkflowRunOnPicker
                className="w-56"
                choice={{
                  runsOn: draft.runsOn === 'local' ? 'local' : 'fleet',
                  ...(draft.runsOnHost ? { runsOnHost: draft.runsOnHost } : {}),
                  ...(draft.runsOnHostId ? { runsOnHostId: draft.runsOnHostId } : {})
                }}
                onChange={(choice) =>
                  change(withWorkflowRunOnChoice({ ...draft, runsOn: choice.runsOn }, choice))
                }
              />
            </BuildReviewSetupRow>
          )}
        </fieldset>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          {hasWarmStartWinner && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => setWarmStartOpen(true)}
            >
              {translate('evolve.warmStart.open', 'Warm-start from local winner')}
            </Button>
          )}
          <Button type="submit" size="sm" disabled={pending}>
            {pending
              ? translate('evolve.starting', 'Starting…')
              : isHosted
                ? translate('evolveHosted.startHosted', 'Start Hosted Super Intelligence')
                : translate('evolve.start', 'Start Evolve')}
          </Button>
        </div>
      </form>
      <EvolveWarmStartModal
        open={warmStartOpen}
        worktreeId={tab.worktreeId}
        runs={runs}
        draft={draft}
        onOpenChange={setWarmStartOpen}
        onConfirm={warmStart}
      />
    </>
  )
}
