import { reserveRendererLaunchCause } from '../observability/launch-trigger-hints'
/** The real dependencies behind `session continue|ask|stop|restart|rename|conflicts`. */

import { randomUUID } from 'node:crypto'
import { interruptSessionAgent, sessionAgentBackAtPrompt } from './session-manage-runtime-interrupt'
import { conversationSourceRowKey, type ConversationSource } from '../../shared/conversation-source'
import type {
  SessionManageRenameReply,
  SessionManageRendererRequest,
  SessionManageResumeReply,
  SessionManageSidebarRow
} from '../../shared/session-manage-relay'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { decideNextSteps } from '../next-steps/next-step-decisions'
import {
  getNextStepKeepGoingController,
  getNextStepSuggestionService,
  onNextStepTurnSignal
} from '../next-steps/next-step-suggestion-slot'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { enqueueConversationPrompt } from '../runtime/prompt-queue-enqueue'
import { bindSessionPrompt } from '../runtime/session-prompt-binding'
import {
  PROMPT_QUEUE_FULL_REFUSAL,
  PROMPT_QUEUE_MAX_ENTRIES,
  promptQueuePending,
  promptQueueTextRefusal
} from '../../shared/prompt-queue-types'
import type { AskWaitDeps } from './session-manage-ask-wait'
import type { SessionManagePaneVerifier } from './session-manage-caller'
import type { ReadChangedFiles } from './session-manage-conflicts'
import type { SessionControlDeps } from './session-manage-control'
import type { SessionDeliveryDeps } from './session-manage-deliver'
import {
  readRuntimeLatestTurn,
  readRuntimeOwnSteps,
  runtimeNeverReplied,
  snapshotRuntimeLatestTurn
} from './session-manage-runtime-sources'

type Runtime = Pick<
  OrcaRuntimeService,
  | 'requestSessionFolders'
  | 'enqueuePromptQueueEntry'
  | 'readPromptQueue'
  | 'settlePromptQueueEntry'
  | 'sendGuardedSessionKey'
  | 'readTerminalAgentEvidence'
  | 'showTerminal'
  | 'getFreshAgentHookStatusForHandle'
  | 'getRuntimeGitStatus'
  | 'verifyOrchestrationCompatibilityCaller'
  | 'getLastAgentHookRowForPane'
  | 'getReportedProviderSessionsForPane'
  | 'resolveTerminalPane'
  | 'hasTerminalUnresolvedDraft'
>

function relay<T>(runtime: Runtime, request: SessionManageRendererRequest): Promise<T> {
  return runtime.requestSessionFolders(request) as Promise<T>
}

/** With `projectFolderId`, that project's threads carry `projectThread`. */
export async function readSidebarRows(
  runtime: Runtime,
  options: { projectFolderId?: string; requireReady?: true } = {}
): Promise<SessionManageSidebarRow[]> {
  const result = await relay<unknown>(runtime, {
    kind: 'listSessions',
    ...(options.projectFolderId ? { projectFolderId: options.projectFolderId } : {}),
    ...(options.requireReady ? { requireReady: true } : {})
  })
  if (!options.projectFolderId) {
    return result as SessionManageSidebarRow[]
  }
  if (
    !result ||
    typeof result !== 'object' ||
    !('projectFolderId' in result) ||
    result.projectFolderId !== options.projectFolderId ||
    !('rows' in result) ||
    !Array.isArray(result.rows)
  ) {
    throw new Error(
      'Project thread listing requires an updated OmniConsole window. Reload the app and try again.'
    )
  }
  return result.rows as SessionManageSidebarRow[]
}

/** The toast for an applied action; the action stands whether or not a window can show it. */
export function showSessionManageNotice(
  runtime: Runtime,
  notice: Extract<SessionManageRendererRequest, { kind: 'notice' }>
): void {
  void relay(runtime, notice).catch(() => {})
}

/** A relayed prompt stops Keep going as the person's own message does; a relayed stop as theirs. */
function keepGoingStopper(reason: 'person-message' | 'person-stopped') {
  return (source: ConversationSource, detail: string): boolean =>
    getNextStepKeepGoingController()?.onSessionManaged(source, detail, reason) ?? false
}

/** A fresh launch is proven by its live PTY, pane, host and launch secret; a chat by its lease. */
export function runtimePaneVerifier(runtime: Runtime): SessionManagePaneVerifier {
  return (evidence) => {
    if (evidence.agentSessionId) {
      return getStructuredAgentSessionHost()?.outcomeSource.authorize(evidence)?.paneKey ?? null
    }
    return (
      runtime.verifyOrchestrationCompatibilityCaller(evidence, {
        currentRuntimeLaunchSufficient: true
      })?.paneKey ?? null
    )
  }
}

export function runtimeDeliveryDeps(runtime: Runtime): SessionDeliveryDeps {
  return {
    enqueue: (source, input) => {
      enqueueConversationPrompt(runtime, source, input)
    },
    admission: (source, text) => {
      const queue = runtime.readPromptQueue(conversationSourceRowKey(source))
      return (
        promptQueueTextRefusal(text) ??
        (queue && promptQueuePending(queue).length >= PROMPT_QUEUE_MAX_ENTRIES
          ? PROMPT_QUEUE_FULL_REFUSAL
          : null)
      )
    },
    bind: (source, entryId, binding) =>
      bindSessionPrompt(conversationSourceRowKey(source), entryId, binding),
    readLatestTurn: (source) => readRuntimeLatestTurn(source, runtimeNeverReplied(runtime)),
    snapshotLatestTurn: (source) => snapshotRuntimeLatestTurn(source, runtimeNeverReplied(runtime)),
    providerSessionId: (source) =>
      runtime.getReportedProviderSessionsForPane(source.paneKey)[0]?.id ?? null,
    hasUnresolvedDraft: (source) => {
      if (source.kind !== 'pty') {
        return false
      }
      try {
        const { handle } = runtime.resolveTerminalPane(source.paneKey, source.worktreeId)
        return runtime.hasTerminalUnresolvedDraft(handle)
      } catch {
        return true
      }
    },
    decideRelayed: (setId, suggestionId, relayed) => {
      const service = getNextStepSuggestionService()
      if (!service) {
        throw new Error('Suggested next steps are not available on this host.')
      }
      return decideNextSteps(
        service,
        setId,
        { action: 'run', suggestionIds: [suggestionId] },
        Date.now(),
        undefined,
        relayed
      )
    },
    stopKeepGoing: keepGoingStopper('person-message'),
    keepGoingOn: (source) =>
      getNextStepKeepGoingController()?.list({ conversation: source })[0]?.enabled === true,
    readOwnSteps: readRuntimeOwnSteps,
    newId: () => randomUUID()
  }
}

export function runtimeControlDeps(runtime: Runtime): SessionControlDeps {
  return {
    interrupt: (handle, receiver, source) =>
      interruptSessionAgent(runtime, handle, receiver, source),
    stopKeepGoing: keepGoingStopper('person-stopped'),
    lastOutputAt: async (handle) => (await runtime.showTerminal(handle)).lastOutputAt,
    stillWorking: async (handle, receiver) =>
      !(await sessionAgentBackAtPrompt(runtime, handle, receiver)),
    resume: (target, launchCause = { trigger: 'session-resume', actor: { kind: 'local-cli' } }) => {
      const launchTabId = reserveRendererLaunchCause({ launchCause, hasStartupCommand: true })
      return relay<SessionManageResumeReply>(runtime, {
        kind: 'resumeSession',
        ...target,
        launchTabId
      })
    },
    rename: (target, title, change) =>
      relay<SessionManageRenameReply>(runtime, {
        kind: 'renameSession',
        ...target,
        title,
        ...(change ? { change } : {})
      }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now()
  }
}

export function runtimeAskWaitDeps(
  runtime: Runtime,
  source: ConversationSource,
  entryId: string
): AskWaitDeps {
  const rowKey = conversationSourceRowKey(source)
  const readEntry = () =>
    runtime.readPromptQueue(rowKey)?.entries.find((entry) => entry.id === entryId)
  return {
    subscribe: onNextStepTurnSignal,
    readEntry,
    withdrawIfQueued: (reason) => {
      // Read and settle in one tick: the drain cannot take it between the two.
      if (readEntry()?.state !== 'queued') {
        return false
      }
      runtime.settlePromptQueueEntry(rowKey, entryId, { state: 'failed', reason })
      return true
    }
  }
}

export function runtimeReadChangedFiles(runtime: Runtime): ReadChangedFiles {
  return async (worktreeId) => {
    const status = await runtime.getRuntimeGitStatus(`id:${worktreeId}`, {
      admissionTier: 'background',
      includeLineStats: false
    })
    const files = status.entries
      .filter((entry) => !entry.submoduleRoot)
      .flatMap((entry) => (entry.oldPath ? [entry.path, entry.oldPath] : [entry.path]))
      .map((path) => path.replace(/\\/g, '/'))
    return { files, branch: status.branch?.replace(/^refs\/heads\//, '') ?? null }
  }
}
