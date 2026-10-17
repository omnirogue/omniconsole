import { useEffect } from 'react'
import { toast } from 'sonner'
import {
  createLocalWorkflowConversation,
  prepareLocalWorkflowTurn,
  titleLocalWorkflowConversation,
  updateLocalWorkflowConversation
} from '@/lib/local-workflow-conversation'
import { openBuildReview } from '@/lib/build-review-entry'
import {
  createLocalWorkflowGraphDraft,
  type LocalWorkflowDraft
} from '../../../../shared/local-workflow-draft'
import { WORKFLOW_ROUTES, type WorkflowRoute } from '../../../../shared/workflow-graph'
import {
  findNextStepAllowed,
  findNextStepPrompt,
  findNextStepSpec
} from '../../../../shared/find-next-step'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import { WorkflowGraphSetup } from '../workflow-graph/WorkflowGraphSetup'
import { WorkflowWorkspaceKindProvider } from '../workflow-graph/WorkflowWorkspaceKind'
import { workflowSeatModelChoices } from '../workflow-graph/workflow-seat-model-choices'
import { workflowModelSources } from '../workflow-graph/workflow-model-sources'
import { WorkflowUnavailableRoutes } from './WorkflowUnavailableRoutes'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { LocalWorkflowController } from './local-workflow-controller'
import { LocalWorkflowExecutionView } from './LocalWorkflowExecutionView'
import { discoverFixBrief } from './discover-run-text'
import { openWorkerTerminal } from '../build-review/open-worker-terminal'
import { translate } from '@/i18n/i18n'
import { AuditWorkflowSetup } from './AuditWorkflowSetup'

/**
 * Every new Council, Discover and custom workflow is a graph. A tab without one yet takes its
 * preset's template over the families this computer can run; an older draft is replaced the same
 * way (its run, if any, keeps its own snapshot).
 */
function graphDraftFor(
  preset: 'council' | 'discover',
  draft: LocalWorkflowDraft | undefined,
  prompt: string,
  routes: readonly WorkflowRoute[]
): LocalWorkflowDraft & { graph: NonNullable<LocalWorkflowDraft['graph']> } {
  const template = draft?.graph?.spec.template
  if (
    (template === 'best-of-n' ||
      template === 'improve' ||
      template === 'find' ||
      template === 'decide' ||
      template === 'investigate') &&
    draft?.graph &&
    !draft.graph.spec.steps.length
  ) {
    return createLocalWorkflowGraphDraft({
      prompt: draft.prompt ?? prompt,
      graph: { spec: workflowTemplate(template, routes), team: [] },
      ...(draft.access ? { access: draft.access } : {}),
      ...(draft.contextSources ? { contextSources: draft.contextSources } : {}),
      ...(draft.includeWorkspace === undefined ? {} : { includeWorkspace: draft.includeWorkspace })
    }) as LocalWorkflowDraft & { graph: NonNullable<LocalWorkflowDraft['graph']> }
  }
  if (draft?.graph) {
    return draft as LocalWorkflowDraft & { graph: NonNullable<LocalWorkflowDraft['graph']> }
  }
  return createLocalWorkflowGraphDraft({
    prompt: draft?.prompt ?? prompt,
    graph: { spec: workflowTemplate(preset, routes), team: [] },
    ...(draft?.access ? { access: draft.access } : {})
  }) as LocalWorkflowDraft & { graph: NonNullable<LocalWorkflowDraft['graph']> }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function LocalAnalysisWorkflowConversation({
  tab,
  controller
}: {
  tab: TerminalTab
  controller?: LocalWorkflowController
}) {
  const workflow = tab.localWorkflow!
  const shownPrompt =
    workflow.executionId && controller?.view?.executionId === workflow.executionId
      ? controller.view.prompt
      : undefined
  useEffect(() => {
    // Also names an execution this tab adopted or restored without its own Start resolving.
    if (shownPrompt) {
      titleLocalWorkflowConversation(tab.id, shownPrompt)
    }
  }, [tab.id, shownPrompt])
  if (workflow.preset === 'build-review' || workflow.preset === 'evolve') {
    return null
  }
  if (workflow.executionId) {
    const view = controller?.view
    if (!view || view.executionId !== workflow.executionId) {
      return (
        <div className="space-y-3">
          <div className="flex justify-end">
            <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg rounded-tr-sm bg-muted px-3.5 py-2.5 text-sm">
              {workflow.prompt}
            </p>
          </div>
          <p role="status" className="text-sm text-muted-foreground">
            {controller?.error ??
              translate('localWorkflow.restoringExecution', 'Restoring workflow execution…')}
          </p>
        </div>
      )
    }
    return (
      <LocalWorkflowExecutionView
        view={view}
        onControl={
          controller.control
            ? (action) => controller.control!(view.executionId, view.fence, action)
            : undefined
        }
        onReadCall={
          controller.readCall
            ? (callId) => controller.readCall!(view.executionId, callId)
            : undefined
        }
        onOpenTerminal={openWorkerTerminal}
        onFollowUp={
          controller.followUp && view.followUpSeat
            ? (prompt, savedResult) => controller.followUp!(view.executionId, prompt, savedResult)
            : undefined
        }
        onNewTurn={async () => {
          if (controller.newTurn) {
            await controller.newTurn(view.executionId)
          } else {
            prepareLocalWorkflowTurn(tab, '')
          }
        }}
        onSaveResult={
          typeof window.api?.runtime?.saveLocalWorkflowResult === 'function'
            ? () =>
                window.api.runtime.saveLocalWorkflowResult({
                  worktree: toRuntimeWorktreeSelector(tab.worktreeId),
                  conversationId: tab.id,
                  executionId: view.executionId
                })
            : undefined
        }
        onOpenLocation={(location) => {
          // Loaded on demand: editor routing pulls in the whole file-open stack.
          void import('./local-workflow-open-location')
            .then(async ({ openLocalWorkflowLocation, workflowLocationProblem }) => {
              const problem = workflowLocationProblem(
                await openLocalWorkflowLocation(tab.id, location),
                location
              )
              if (problem) {
                toast.error(problem)
              }
            })
            .catch((error: unknown) => toast.error(errorText(error)))
        }}
        resultsTarget={{ worktreeId: tab.worktreeId, tabId: tab.id }}
        onFindNextStep={(step, keys) => {
          const run = view.graphRun
          if (!run?.find || !findNextStepAllowed(run.spec)) {
            return
          }
          try {
            // Opened to review and start, like a fix from Discover: nothing runs until Start.
            const prompt = findNextStepPrompt(view.prompt, run.find, step, keys)
            if (step === 'build') {
              // Build + Review makes the change and has it reviewed.
              openBuildReview(tab.worktreeId, { prompt })
              return
            }
            if (step === 'look-closer') {
              // Decide weighs the choice.
              const nextTab = createLocalWorkflowConversation(tab.worktreeId, 'decide')
              updateLocalWorkflowConversation(tab.worktreeId, nextTab, { prompt })
              return
            }
            const improveTab = createLocalWorkflowConversation(tab.worktreeId, 'improve')
            updateLocalWorkflowConversation(tab.worktreeId, improveTab, {
              prompt,
              draft: createLocalWorkflowGraphDraft({
                prompt,
                graph: { spec: findNextStepSpec(run.spec), team: [] }
              })
            })
          } catch (error) {
            toast.error(errorText(error))
          }
        }}
        onFixWithBuildReview={(item) => {
          openBuildReview(tab.worktreeId, { prompt: discoverFixBrief(item, view.prompt) })
        }}
        onRunAgain={() => {
          try {
            // Why the tab's own copy second: a run whose snapshot is unreadable has no question.
            prepareLocalWorkflowTurn(tab, view.prompt || workflow.prompt)
          } catch (error) {
            toast.error(errorText(error))
          }
        }}
      />
    )
  }
  const auditDraft = workflow.startRequest?.draft ?? workflow.draft
  if (auditDraft?.audit) {
    const unavailable = !controller
      ? translate(
          'localWorkflow.setup.hostUnavailable',
          'Workflows are not available on this host.'
        )
      : (controller.error ??
        controller.unavailableReason ??
        (!controller.loading && !controller.auditSupport
          ? translate(
              'localWorkflow.audit.updateHost',
              'Update this computer’s runtime to start Audit workflows.'
            )
          : undefined))
    return (
      <AuditWorkflowSetup
        draft={auditDraft}
        team={controller?.auditTeam ?? []}
        catalog={controller?.catalog ?? []}
        maxConcurrency={controller?.maxConcurrency ?? 1}
        loading={controller?.loading}
        unavailableReason={unavailable}
        recoveringStart={Boolean(workflow.startRequest)}
        onChange={(draft) =>
          updateLocalWorkflowConversation(tab.worktreeId, tab.id, { draft, prompt: draft.prompt })
        }
        onStart={async (draft) => {
          if (!controller) {
            throw new Error('Workflows are not available on this host.')
          }
          const started = await controller.start(draft)
          updateLocalWorkflowConversation(tab.worktreeId, tab.id, {
            draft,
            prompt: draft.prompt,
            executionId: started.executionId
          })
          titleLocalWorkflowConversation(tab.id, draft.prompt)
        }}
      />
    )
  }
  const team = controller?.graphTeam ?? []
  const routes = WORKFLOW_ROUTES.filter((route) => team.some((seat) => seat.agent === route))
  const graphDraft = graphDraftFor(
    workflow.preset,
    workflow.startRequest?.draft ?? workflow.draft,
    workflow.prompt,
    routes.length ? routes : WORKFLOW_ROUTES
  )
  const unavailable = !controller
    ? translate('localWorkflow.setup.hostUnavailable', 'Workflows are not available on this host.')
    : controller.loading
      ? translate('localWorkflow.setup.loading', 'Checking which models are available…')
      : (controller.unavailableReason ?? controller.error)
  return (
    <div className="space-y-2">
      <WorkflowWorkspaceKindProvider worktreeId={tab.worktreeId}>
        <WorkflowGraphSetup
          // A template drawn before the host listed its models is drawn again once it has.
          key={routes.join(',')}
          worktreeId={tab.worktreeId}
          draft={graphDraft}
          available={routes}
          models={workflowSeatModelChoices(controller?.catalog ?? [], team)}
          sources={workflowModelSources(controller?.catalog ?? [], team)}
          recoveringStart={Boolean(workflow.startRequest)}
          unavailableReason={unavailable}
          loading={Boolean(controller?.loading)}
          onChange={(next) =>
            updateLocalWorkflowConversation(tab.worktreeId, tab.id, {
              draft: next,
              prompt: next.prompt
            })
          }
          onStart={async (next) => {
            if (!controller) {
              throw new Error(
                translate(
                  'localWorkflow.setup.hostUnavailable',
                  'Workflows are not available on this host.'
                )
              )
            }
            const ready = { ...next, graph: { ...next.graph!, team: [...controller.graphTeam] } }
            const started = await controller.start(ready)
            updateLocalWorkflowConversation(tab.worktreeId, tab.id, {
              draft: ready,
              prompt: ready.prompt,
              executionId: started.executionId
            })
            titleLocalWorkflowConversation(tab.id, ready.prompt)
          }}
        />
      </WorkflowWorkspaceKindProvider>
      {controller && !controller.loading && !controller.error ? (
        <WorkflowUnavailableRoutes catalog={controller.catalog} team={team} />
      ) : null}
    </div>
  )
}
