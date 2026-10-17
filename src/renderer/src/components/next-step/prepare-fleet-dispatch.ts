import { useAppStore } from '@/store'
import { consoleWorkflowApi, workflowData } from '@/lib/console-workflow-client'
import {
  readConversationFleetContext,
  type CapturedConversationFleetContext
} from '@/lib/conversation-fleet-context'
import {
  prepareConversationFleetInputs,
  type ConversationFleetInputSelection
} from '@/lib/conversation-fleet-inputs'
import { buildConversationFleetWorkflow } from '../../../../shared/conversation-fleet-workflow'
import { resolveConversationFleetFolderMachine } from '../../../../shared/conversation-fleet-machine'
import { normalizeGitRemoteUrl } from '../../../../shared/git-remote-identity'
import type {
  ConsoleConversationFleetInventory,
  ConsoleConversationFleetPreview
} from '../../../../shared/console-conversation-fleet-types'
import type { NextStepDraft } from '../../../../shared/next-step-draft'
import { translate } from '@/i18n/i18n'
import type { FleetDispatchReview } from './fleet-dispatch-types'
import type { NextStepSubject } from './next-step-subject'

type Subject = Extract<NextStepSubject, { kind: 'session' }>
export type FrozenDispatch = {
  scope: string
  review: FleetDispatchReview
  admitted: ConsoleConversationFleetPreview
  machine: string | null
  captured: CapturedConversationFleetContext
  capturedAt: string
}

function registeredRepo(inventory: ConsoleConversationFleetInventory, remoteUrl: string): string {
  const canonical = normalizeGitRemoteUrl(remoteUrl)
  if (!canonical) {
    throw new Error('This source does not have a portable repository remote.')
  }
  const found = inventory.repositories.find(
    (repo) =>
      normalizeGitRemoteUrl(
        repo.id.includes('://') || repo.id.startsWith('git@')
          ? repo.id
          : `https://github.com/${repo.id}`
      ) === canonical
  )
  if (!found) {
    throw new Error(
      translate(
        'conversationFleet.repoUnavailable',
        'This repository is not available to the fleet. Register it before dispatching this work.'
      )
    )
  }
  return found.id
}

export async function prepareFleetDispatch({
  subject,
  draft,
  selectedMachine,
  fanoutAcknowledged,
  sourceSelection,
  operationId,
  requestScope,
  signal,
  refresh,
  assertCurrent
}: {
  subject: Subject
  draft: NextStepDraft
  selectedMachine?: string
  fanoutAcknowledged: boolean
  sourceSelection: ConversationFleetInputSelection
  operationId: string
  requestScope: string
  signal: AbortSignal
  refresh: () => Promise<ConsoleConversationFleetInventory>
  assertCurrent: () => void
}): Promise<FrozenDispatch> {
  const taskId = draft.handoff.task?.id
  const hasAgents = [...draft.recipients, ...draft.after].some((entry) => entry.kind === 'agent')
  if (!taskId) {
    throw new Error(
      translate('conversationFleet.taskRequired', 'Choose the task this work belongs to.')
    )
  }
  const offered = await refresh()
  assertCurrent()
  const taskContext = workflowData(await consoleWorkflowApi().fleetTaskContext({ taskId }))
  assertCurrent()
  if (!taskContext.supported) {
    throw new Error(taskContext.reason ?? 'This task cannot accept a fleet workflow yet.')
  }
  const capturedAt = new Date().toISOString()
  const captured = await readConversationFleetContext(subject.session, signal)
  assertCurrent()
  const state = useAppStore.getState()
  const workspace = state.getKnownWorktreeById(subject.session.worktreeId, captured.sourceHostId)
  if (!workspace) {
    throw new Error('The source work location is unavailable.')
  }
  const repos = state.repos.filter((repo) => repo.id === workspace.repoId)
  if (repos.length > 1) {
    throw new Error('The source repository owner is ambiguous.')
  }
  const sourceRepo = repos[0]
  const isFolder = sourceRepo?.kind === 'folder' || subject.session.worktreeId.startsWith('folder:')
  const remote = sourceRepo?.gitRemoteIdentity?.remoteUrl
  if (
    hasAgents &&
    sourceRepo?.kind !== 'folder' &&
    !subject.session.worktreeId.startsWith('folder:') &&
    !remote
  ) {
    throw new Error('The source repository identity has not been verified yet.')
  }
  const inputs = await prepareConversationFleetInputs({
    taskId,
    session: subject.session,
    context: captured,
    selection: sourceSelection,
    ...(draft.recipients.some((recipient) => recipient.kind === 'person')
      ? {
          handoff: draft.handoff,
          includeTranscript: draft.handoff.includeTranscript === true
        }
      : {}),
    capturedAt,
    signal: signal
  })
  assertCurrent()
  if (
    remote &&
    (!inputs.remoteUrl || normalizeGitRemoteUrl(inputs.remoteUrl) !== normalizeGitRemoteUrl(remote))
  ) {
    throw new Error('The source repository changed during capture. Review the dispatch again.')
  }
  if (remote && !inputs.baseCommit) {
    throw new Error('The source repository commit could not be verified.')
  }
  if (isFolder && (inputs.remoteUrl || inputs.baseCommit)) {
    throw new Error(
      'The source workspace changed from a folder to a repository. Review the dispatch again.'
    )
  }
  const dispatchMachine = !hasAgents
    ? undefined
    : isFolder
      ? resolveConversationFleetFolderMachine(draft, offered, {
          settings: state.settings,
          sourceWorkspacePath: captured.sourceWorkspacePath,
          selectedMachine,
          sourceSummaryFile: inputs.sourceSummaryFile,
          sourceDeliverableFiles: inputs.sourceDeliverableFiles,
          sourceDeliverablePaths: inputs.sourceDeliverablePaths,
          sourceDeliverables: inputs.sourceDeliverables
        })
      : selectedMachine
  const context = workflowData(await consoleWorkflowApi().fleetTaskContext({ taskId }))
  assertCurrent()
  if (!context.supported) {
    throw new Error(context.reason ?? 'This task cannot accept a fleet workflow yet.')
  }
  const compiled = buildConversationFleetWorkflow({
    operationId,
    draft,
    context: inputs.context,
    sourceSummaryFile: inputs.sourceSummaryFile,
    sourceDeliverableFiles: inputs.sourceDeliverableFiles,
    sourceDeliverablePaths: inputs.sourceDeliverablePaths,
    sourceDeliverables: inputs.sourceDeliverables,
    ...(inputs.sourceTranscript ? { sourceTranscript: inputs.sourceTranscript } : {}),
    companySlug: context.filing.company_slug,
    ...(hasAgents && inputs.remoteUrl
      ? {
          repo: registeredRepo(offered, inputs.remoteUrl),
          baseBranch: inputs.branch?.replace(/^refs\/heads\//, '')
        }
      : {}),
    ...(hasAgents && inputs.baseCommit ? { baseCommit: inputs.baseCommit } : {}),
    ...(dispatchMachine ? { machine: dispatchMachine } : {}),
    ...(isFolder && dispatchMachine
      ? {
          workspace: {
            kind: 'folder' as const,
            host: dispatchMachine,
            allocation: 'job' as const
          }
        }
      : {}),
    settings: state.settings
  })
  const preview = workflowData(
    await consoleWorkflowApi().previewFleetTask({
      taskId,
      expectedRevision: context.expected_revision,
      classification: compiled.classification,
      prompt: compiled.prompt,
      fanoutAck: fanoutAcknowledged,
      sourceFiles: inputs.sourceFiles,
      sourceDeletions: inputs.sourceDeletions,
      sourceSummaryFile: inputs.sourceSummaryFile,
      source: {
        sessionRef: subject.session.rowKey,
        capturedAt,
        ...(subject.session.sessionKey ? { sessionId: subject.session.sessionKey } : {}),
        transcriptDigest: inputs.transcriptDigest
      }
    })
  )
  assertCurrent()
  const review: FleetDispatchReview = {
    preview,
    machineLabel: !hasAgents
      ? translate('conversationFleet.peopleDelivery', 'Deliver to people')
      : (dispatchMachine ?? translate('conversationFleet.automatic', 'An available fleet Mac')),
    contextSummary: translate(
      'conversationFleet.contextIncluded',
      'Conversation context from “{{title}}” is included.',
      { title: captured.title }
    ),
    inputs: inputs.sourceFiles.map((pin) => ({
      name: pin.file.name,
      sizeBytes: pin.file.size_bytes,
      ...(pin.target_path ? { targetPath: pin.target_path } : {})
    })),
    warnings: inputs.warnings,
    sourceCommit: inputs.baseCommit
  }
  return {
    scope: requestScope,
    review,
    admitted: preview,
    machine: dispatchMachine ?? null,
    captured,
    capturedAt
  }
}
