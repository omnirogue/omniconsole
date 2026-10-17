import { useCallback, useEffect, useState } from 'react'
import { History } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { BuildReviewStartForm } from '../build-review/BuildReviewStartForm'
import { BuildReviewDetail } from '../build-review/BuildReviewDetail'
import { BuildReviewReadFailure } from '../build-review/BuildReviewReadFailure'
import { EvolveConversation } from '../evolve/EvolveConversation'
import {
  titleLocalWorkflowConversation,
  updateLocalWorkflowConversation
} from '@/lib/local-workflow-conversation'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { BuildReviewDraft } from '../../../../shared/build-review-draft'
import { LocalAnalysisWorkflowConversation } from './LocalAnalysisWorkflowConversation'
import type { LocalWorkflowController } from './local-workflow-controller'
import { useLocalWorkflowController } from './use-local-workflow-controller'
import { WorkflowPresetIcon, workflowAnchorKind, workflowPresetLabel } from './workflow-presets'
import { WorkflowGuideCard } from './WorkflowGuideCard'

export function LocalWorkflowConversation({
  tab,
  onClose,
  controller
}: {
  tab: TerminalTab
  onClose?: () => void
  controller?: LocalWorkflowController
}) {
  const workflow = tab.localWorkflow!
  const hostController = useLocalWorkflowController(tab, !controller)
  const [pending, setPending] = useState(false)
  const [readFailure, setReadFailure] = useState<{ id: string; message: string } | null>(null)
  const saveBuildReviewDraft = useCallback(
    (draft: BuildReviewDraft) => {
      updateLocalWorkflowConversation(tab.worktreeId, tab.id, {
        buildReviewDraft: draft,
        prompt: draft.objective
      })
    },
    [tab.worktreeId, tab.id]
  )
  const pipeline = useAppStore((state) =>
    workflow.buildReviewPipelineId
      ? state.buildReview.pipelinesById[workflow.buildReviewPipelineId]
      : undefined
  )
  const pipelineId = workflow.buildReviewPipelineId
  const refreshPipeline = useCallback(async () => {
    if (!pipelineId) {
      return
    }
    const error = await useAppStore.getState().buildReview.refreshOne(pipelineId)
    setReadFailure(error ? { id: pipelineId, message: error } : null)
  }, [pipelineId])
  const failure = readFailure && readFailure.id === pipelineId ? readFailure.message : null
  // One read on open; after that the buildReview:changed push keeps the store current.
  useEffect(() => {
    if (pipelineId) {
      void refreshPipeline()
    }
  }, [pipelineId, refreshPipeline])
  const kind = workflowAnchorKind(workflow)
  const label = workflowPresetLabel(kind)
  const title = tab.customTitle ?? label
  return (
    <section
      className="absolute inset-0 flex min-w-0 flex-col bg-background"
      aria-label={label}
      data-local-workflow={tab.id}
    >
      <header className="flex min-h-12 min-w-0 items-center justify-between gap-3 border-b px-4 py-2 sm:px-6">
        <div className="flex min-w-0 items-center gap-2">
          <WorkflowPresetIcon preset={kind} className="text-muted-foreground" />
          <h2 className="truncate text-sm font-semibold">{title}</h2>
          {title !== label && (
            <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {workflow.preset === 'build-review' && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
              onClick={() => {
                if (pipelineId) {
                  useAppStore.getState().buildReview.select(pipelineId)
                }
                useAppStore.getState().openBuildReviewPage()
              }}
            >
              <History aria-hidden="true" className="size-3.5" />
              {translate('localWorkflow.allBuildReviewRuns', 'View all Build + Review runs')}
            </Button>
          )}
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onClose}>
            {translate('localWorkflow.close', 'Close')}
          </Button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 scrollbar-sleek sm:p-6">
        {workflow.preset === 'build-review' && failure && (
          <BuildReviewReadFailure message={failure} onRetry={() => void refreshPipeline()} />
        )}
        {workflow.preset === 'evolve' ? (
          <EvolveConversation tab={tab} />
        ) : workflow.preset === 'build-review' ? (
          pipeline ? (
            <BuildReviewDetail pipeline={pipeline} />
          ) : workflow.buildReviewPipelineId ? (
            !failure && (
              <p role="status" className="text-sm text-muted-foreground">
                {translate('localWorkflow.loadingBuildReview', 'Loading Build + Review…')}
              </p>
            )
          ) : (
            <div className="mx-auto max-w-2xl">
              <BuildReviewStartForm
                initialWorktree={tab.worktreeId}
                initialObjective={workflow.prompt}
                initialDraft={workflow.buildReviewDraft}
                onDraftChange={saveBuildReviewDraft}
                pending={pending}
                setPending={setPending}
                onCancel={() => onClose?.()}
                onStart={async (request) => {
                  const started = await useAppStore
                    .getState()
                    .buildReview.start(request, { reveal: false })
                  updateLocalWorkflowConversation(tab.worktreeId, tab.id, {
                    buildReviewPipelineId: started.id,
                    prompt: request.objective
                  })
                  titleLocalWorkflowConversation(tab.id, request.objective)
                }}
              />
            </div>
          )
        ) : (
          <div
            data-workflow-message-column
            className={
              workflow.executionId
                ? 'mx-auto w-full max-w-4xl'
                : 'mx-auto flex min-h-full w-full max-w-4xl flex-col justify-center py-6'
            }
          >
            {/* A start in flight may yet adopt a running execution: no guide until it settles. */}
            {!workflow.executionId && !workflow.startRequest && (
              <WorkflowGuideCard kind={kind} className="mb-4" />
            )}
            <LocalAnalysisWorkflowConversation
              tab={tab}
              controller={controller ?? hostController}
            />
          </div>
        )}
      </div>
    </section>
  )
}
