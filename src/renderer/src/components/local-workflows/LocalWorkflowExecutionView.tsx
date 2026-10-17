import { useState } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type {
  LocalWorkflowReadCallResult,
  LocalWorkflowSaveResult
} from '../../../../shared/local-workflow-rpc'
import type { LocalWorkflowAction, LocalWorkflowView } from '../../../../shared/local-workflow-view'
import type { FindNextStep } from '../../../../shared/find-next-step'
import { workflowResultDocument } from '../../../../shared/workflow-graph-web'
import { deanonymizeCouncilText } from './council-run-text'
import { CouncilRunView } from './CouncilRunView'
import type { DiscoverReportItem } from './discover-run-text'
import { DiscoverRunView } from './DiscoverRunView'
import { LocalWorkflowFollowUp } from './LocalWorkflowFollowUp'
import { useWorkflowRunActions, type LocalWorkflowSavedResult } from './use-workflow-run-actions'
import type { WorkflowCallHandlers } from './WorkflowCallBody'
import { WorkflowGenericRun } from './WorkflowGenericRun'
import { WorkflowResultActions, WorkflowUsageLine } from './WorkflowResult'
import { WorkflowRunError } from './WorkflowRunError'
import { WorkflowRunHeader } from './WorkflowRunHeader'
import { WorkflowRunNotes } from './WorkflowRunNotes'
import { WorkflowUnreadableRun } from './WorkflowUnreadableRun'
import { workflowRunNoteEntries } from './workflow-run-notes'
import { workflowPresetLabel } from './workflow-presets'
import { WorkflowGraphRunView } from '../workflow-graph/WorkflowGraphRunView'
import { workflowResults } from '../workflow-results/workflow-results-candidates'
import type { WorkflowResultsTarget } from '../workflow-results/WorkflowResultsLaunchDialog'
import { WorkflowResultsPanel } from '../workflow-results/WorkflowResultsPanel'

export type LocalWorkflowExecutionViewProps = {
  view: LocalWorkflowView
  onControl?: (action: LocalWorkflowAction) => Promise<void>
  onReadCall?: (callId: string) => Promise<LocalWorkflowReadCallResult>
  /** Opens a working agent's own terminal by its handle. */
  onOpenTerminal?: (handle: string) => Promise<void>
  onFollowUp?: (prompt: string, savedResult?: LocalWorkflowSavedResult) => Promise<void>
  onNewTurn?: () => Promise<void>
  onSaveResult?: () => Promise<LocalWorkflowSaveResult>
  /** Opens "path:line" in the editor; without it locations are copied. */
  onOpenLocation?: (location: string) => void
  /** Discover report: opens a Build + Review conversation for one item. */
  onFixWithBuildReview?: (item: DiscoverReportItem) => void
  /** A run this version cannot reopen: starts the same question again in a new conversation. */
  onRunAgain?: () => void
  /** Where a session started from chosen results opens (the conversation's workspace and tab). */
  resultsTarget?: WorkflowResultsTarget
  /** Find the best: open Improve or a Council on the chosen options, by their keys. */
  onFindNextStep?: (step: FindNextStep, keys: string[]) => void
}

/** The run: the question, one status line, then the preset's live stage rail and result. */
export function LocalWorkflowExecutionView({
  view,
  onControl,
  onReadCall,
  onOpenTerminal,
  onFollowUp,
  onNewTurn,
  onSaveResult,
  onOpenLocation,
  onFixWithBuildReview,
  onRunAgain,
  resultsTarget,
  onFindNextStep
}: LocalWorkflowExecutionViewProps) {
  const actions = useWorkflowRunActions(view, onSaveResult)
  const [followUpOpen, setFollowUpOpen] = useState(false)
  const { connected, pending } = actions
  const settled = ['completed', 'cancelled', 'failed'].includes(view.state)
  const followUp = connected && view.state === 'completed' && view.result ? onFollowUp : undefined
  const newTurnLabel =
    view.graphRun || view.audit
      ? translate('localWorkflow.run.runAgain', 'Run again')
      : view.preset === 'council'
        ? translate('localWorkflow.run.newQuestion', 'New question')
        : translate('localWorkflow.run.newSearch', 'New search')
  const handlers: WorkflowCallHandlers = { onReadCall, onOpenTerminal }
  const results = workflowResults(view)
  // Copy takes what the reader sees: a Council answer with model names, not anonymous labels.
  const shownResult =
    view.result && view.councilRun
      ? deanonymizeCouncilText(view.result.markdown, view.councilRun.members)
      : view.result && workflowResultDocument(view.result)
  const resultFooter = view.result ? (
    <div className="space-y-1.5">
      <WorkflowResultActions
        markdown={shownResult ?? workflowResultDocument(view.result)}
        disabled={pending || !connected}
        savedPath={actions.savedResult?.filePath ?? view.savedOutput?.filePath}
        followUpOpen={followUpOpen}
        newTurnLabel={newTurnLabel}
        onSave={
          view.state === 'completed' && actions.save ? () => void actions.save?.() : undefined
        }
        onToggleFollowUp={followUp ? () => setFollowUpOpen(!followUpOpen) : undefined}
        onNewTurn={onNewTurn ? () => void actions.perform(onNewTurn) : undefined}
      />
      <WorkflowUsageLine usage={view.usage} />
    </div>
  ) : undefined
  if (view.unreadable) {
    return <WorkflowUnreadableRun view={view} onRunAgain={onRunAgain} />
  }
  return (
    <article className="space-y-5" data-execution-id={view.executionId}>
      <div className="flex justify-end">
        <p
          className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg rounded-tr-sm bg-muted px-3.5 py-2.5 text-sm"
          aria-label={translate('localWorkflow.run.yourRequest', 'Your request')}
        >
          {view.prompt}
        </p>
      </div>
      <WorkflowRunHeader
        view={view}
        pending={pending}
        onAction={onControl ? (action) => void actions.perform(() => onControl(action)) : undefined}
      />
      {actions.error ? (
        <p role="alert" className="text-sm text-destructive">
          {actions.error}
        </p>
      ) : view.error ? (
        <WorkflowRunError error={view.error} />
      ) : null}
      {view.outputError && (
        <p role="alert" className="text-sm text-destructive">
          {translate('localWorkflow.outputError', 'Automatic file save failed: {{message}}', {
            message: view.outputError
          })}
        </p>
      )}
      {view.graphRun ? (
        <WorkflowGraphRunView
          view={view}
          handlers={handlers}
          resultFooter={resultFooter}
          onOpenLocation={onOpenLocation}
        />
      ) : view.councilRun ? (
        <CouncilRunView
          view={view}
          run={view.councilRun}
          handlers={handlers}
          resultFooter={resultFooter}
        />
      ) : view.discoverRun ? (
        <DiscoverRunView
          view={view}
          run={view.discoverRun}
          handlers={handlers}
          onOpenLocation={onOpenLocation}
          onFix={onFixWithBuildReview}
          resultFooter={resultFooter}
        />
      ) : (
        <WorkflowGenericRun view={view} handlers={handlers} resultFooter={resultFooter} />
      )}
      {results ? (
        <WorkflowResultsPanel
          // A new run starts from its own defaults, not the last run's ticks.
          key={view.executionId}
          view={view}
          results={results}
          target={resultsTarget}
          onFindNextStep={onFindNextStep}
        />
      ) : null}
      {settled && !view.result ? <WorkflowUsageLine usage={view.usage} /> : null}
      <WorkflowRunNotes entries={workflowRunNoteEntries(view.log, view.discoverRun?.dropped)} />
      {followUpOpen && followUp && (
        <LocalWorkflowFollowUp
          autoFocus
          label={view.followUpLabel ?? workflowPresetLabel(view.audit ? 'audit' : view.preset)}
          disabled={pending}
          onSubmit={(prompt) => followUp(prompt, actions.savedResult)}
        />
      )}
      {onNewTurn && settled && !view.result && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          disabled={pending || !connected}
          onClick={() => void actions.perform(onNewTurn)}
        >
          <Plus aria-hidden="true" className="size-3.5" />
          {view.graphRun || view.audit
            ? translate('localWorkflow.run.runAgain', 'Run again')
            : view.preset === 'council'
              ? translate('localWorkflow.run.askAgain', 'Ask the council again')
              : translate('localWorkflow.run.searchAgain', 'Run Discover again')}
        </Button>
      )}
    </article>
  )
}
