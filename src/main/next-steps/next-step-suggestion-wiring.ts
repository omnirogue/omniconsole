/**
 * Starts suggested next steps on this host and installs the service the `nextSteps.*` methods reach.
 *
 * Automatic triggers: every live hook-reported agent pane (Claude and Codex PTY `Stop`), and
 * every chat session's status feed (Claude and Codex structured). Anything else is manual.
 * The same finished replies also record the Slite docs and omnios pages each conversation links,
 * which the right panel shows (`session-linked-docs-store.ts`).
 */

import {
  conversationSourceRowKey,
  structuredConversationSource,
  type ConversationSource
} from '../../shared/conversation-source'
import { nextStepReplyDecision } from '../../shared/next-step-reply-decision'
import { createNextStepReplyPtyProof } from '../../shared/next-step-reply-proof'
import { normalizeNextStepSuggestionSettings } from '../../shared/next-step-suggestion-settings'
import { agentHookServer } from '../agent-hooks/server'
import { registerPaneKeyTeardownListener } from '../ipc/pty/pane/key-state'
import {
  getStructuredAgentSessionHost,
  subscribeStructuredAgentSessionHost
} from '../native-chat/agent-session-wire/structured-agent-session-registry'
import type { Store } from '../persistence'
import { isChainBoundToConversation } from '../runtime/conversation-chain-ownership'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { enqueueConversationPrompt } from '../runtime/prompt-queue-enqueue'
import { recheckWriteFences } from '../runtime/conversation-write-fence'
import { followConversationChangesForWriteFences } from '../runtime/conversation-write-fence-feeds'
import { generateNextSteps, type NextStepGeneratorDeps } from './next-step-suggestion-generator'
import { generateNextStepStart } from './next-step-start-generator'
import { readConsoleTaskCard } from '../backoffice/console-session-task'
import { nextStepWorkspaceLane, resolveNextStepWorkspace } from './next-step-workspace'
import { NextStepKeepGoingController } from './next-step-keep-going'
import {
  followChatAttention,
  hookRowAttention,
  readChatAttention
} from './next-step-keep-going-feeds'
import type { NextStepKeepGoingJudges } from './next-step-keep-going-judge'
import { NextStepKeepGoingStore } from './next-step-keep-going-store'
import { NextStepSuggestionService } from './next-step-suggestion-service'
import {
  emitNextStepTurnSignal,
  getNextStepKeepGoingController,
  getNextStepSuggestionService,
  onNextStepTurnSignal,
  setNextStepKeepGoingController,
  setNextStepSuggestionService
} from './next-step-suggestion-slot'
import { NextStepSuggestionStore } from './next-step-suggestion-store'
import { NextStepJev } from './next-step-jev'
import { getNextStepJev, setNextStepJev } from './next-step-jev-slot'
import { followStructuredTurns, readStructuredLatestTurn } from './next-step-structured-turns'
import { classifyHookTurnSignal, type FinishedTurn, type TurnSignal } from './next-step-turn-signal'
import { noteNextStepStartActivity } from './next-step-start-activity'
import {
  getSessionLinkedDocsStore,
  SessionLinkedDocsStore,
  setSessionLinkedDocsStore
} from '../artifacts/session-linked-docs-store'

function readPtyLatestTurn(
  source: ConversationSource,
  resolveWorktreeId: (paneKey: string) => string | null
): FinishedTurn | null {
  const row = agentHookServer.getStatusSnapshotForPane(source.paneKey)[0]
  if (!row) {
    return null
  }
  const signal = classifyHookTurnSignal(
    { ...row, restoredUnconfirmed: undefined, payload: row },
    resolveWorktreeId
  )
  return signal.kind === 'finished' &&
    conversationSourceRowKey(signal.turn.conversation) === conversationSourceRowKey(source)
    ? signal.turn
    : null
}

export function startNextStepSuggestions(options: {
  store: Store
  runtime: OrcaRuntimeService
  userDataPath: string
  /** Every finished reply, for the documents it names (the session ledger's Work log links). */
  onReplyDocuments?: (paneKey: string, reply: string, apiOrigin: string | null) => void
}): () => Promise<void> {
  const { store, runtime } = options
  let keepGoing: NextStepKeepGoingController | null = null
  const settings = () =>
    normalizeNextStepSuggestionSettings(store.getSettings().nextStepSuggestions)
  // JEV ranks each set and reads doneness; Keep going may inject `jev.assessDoneness`.
  const jev = new NextStepJev({ settings, readTaskCard: readConsoleTaskCard })
  const suggestionStore = new NextStepSuggestionStore({
    directory: options.userDataPath,
    onChange: () => {
      keepGoing?.onSetsChanged()
      jev.onSetsChanged()
      recheckWriteFences()
    }
  })
  suggestionStore.load()
  const resolveWorktreeId = (paneKey: string): string | null =>
    runtime.getTerminalWorktreeIdForPaneKey(paneKey) ?? null
  const workspaceLaneOf = (worktreeId: string): string | null => {
    const workspace = resolveNextStepWorkspace(store, worktreeId)
    return workspace ? nextStepWorkspaceLane(workspace) : null
  }
  const generatorDeps: NextStepGeneratorDeps = {
    store,
    settings,
    agentEnv: () => runtime.getCommitMessageAgentEnvironmentResolvers(),
    readGitStatus: (worktreeId: string) =>
      runtime.getRuntimeGitStatus(`id:${worktreeId}`, {
        admissionTier: 'background',
        includeLineStats: true
      })
  }
  const next = new NextStepSuggestionService({
    store: suggestionStore,
    settings,
    readPromptQueue: (source) => runtime.readPromptQueue(conversationSourceRowKey(source)),
    isChainBound: (source) => isChainBoundToConversation(runtime, source),
    laneOf: (source) => workspaceLaneOf(source.worktreeId),
    workspaceLaneOf,
    isConversationLive: (source) => {
      if (source.kind === 'pty') {
        return runtime.getTerminalWorktreeIdForPaneKey(source.paneKey) !== null
      }
      // Unknown host = live: a set is never carried away from a session that might answer it.
      const host = getStructuredAgentSessionHost()
      try {
        return (
          !host ||
          host.liveSessionStatusSummaries().some((entry) => entry.sessionId === source.sessionId)
        )
      } catch (error) {
        console.warn('[next-steps] chat session liveness unreadable; treating as live', error)
        return true
      }
    },
    enqueue: (source, input) => {
      enqueueConversationPrompt(runtime, source, input)
    },
    generate: async (turn, signal, context) => {
      // The goal tells the suggester what the work is for; an unreadable one is simply left out.
      const goal = await jev.goalFor(turn).catch(() => null)
      const outcome = await generateNextSteps(generatorDeps, turn, signal, { ...context, goal })
      return jev.judgeGenerated(turn, outcome, signal)
    },
    readDoneness: jev.readDoneness,
    generateStart: (request, signal) =>
      generateNextStepStart(
        { ...generatorDeps, readTaskCard: readConsoleTaskCard },
        request,
        signal
      ),
    readLatestTurn: async (source) =>
      source.kind === 'structured' && source.sessionId
        ? readStructuredLatestTurn(
            getStructuredAgentSessionHost(),
            source.worktreeId,
            source.sessionId
          )
        : readPtyLatestTurn(source, resolveWorktreeId),
    readReplyDecisionPtyProof: (source) => {
      const row = agentHookServer.getStatusSnapshotForPane(source.paneKey)[0]
      const turn = readPtyLatestTurn(source, resolveWorktreeId)
      return row &&
        !row.connectionId &&
        turn &&
        resolveWorktreeId(source.paneKey) === source.worktreeId
        ? createNextStepReplyPtyProof(turn.turnKey, row)
        : null
    },
    listReplyDecisionSources: () => [
      ...agentHookServer.getStatusSnapshot().flatMap((row) => {
        if (row.connectionId || !nextStepReplyDecision(row.lastAssistantMessage ?? '')) {
          return []
        }
        const signal = classifyHookTurnSignal(
          { ...row, restoredUnconfirmed: undefined, payload: row },
          resolveWorktreeId
        )
        return signal.kind === 'finished' &&
          resolveWorktreeId(row.paneKey) === signal.turn.conversation.worktreeId
          ? [signal.turn.conversation]
          : []
      }),
      ...(getStructuredAgentSessionHost()?.liveSessionStatusSummaries() ?? []).flatMap((row) =>
        row.status === 'idle' && nextStepReplyDecision(row.lastAssistantMessage ?? '')
          ? [structuredConversationSource(row.workspaceId, row.sessionId)]
          : []
      )
    ]
  })
  setNextStepSuggestionService(next)
  const linkedDocs = new SessionLinkedDocsStore({ directory: options.userDataPath })
  linkedDocs.load()
  setSessionLinkedDocsStore(linkedDocs)
  jev.attach(next)
  setNextStepJev(jev)
  const keepGoingStore = new NextStepKeepGoingStore({ directory: options.userDataPath })
  keepGoingStore.load()
  // JEV's done / no-more-improvement readings; null (no stop) when JEV is off or unavailable.
  const keepGoingJudges: NextStepKeepGoingJudges = jev.keepGoingJudges()
  const controller = new NextStepKeepGoingController({
    ...keepGoingJudges,
    service: next,
    store: keepGoingStore,
    readAttention: (source) => {
      if (source.kind === 'structured') {
        return readChatAttention(getStructuredAgentSessionHost(), source)
      }
      const row = agentHookServer.getStatusSnapshotForPane(source.paneKey)[0]
      return row ? hookRowAttention(row) : null
    },
    // Fails closed: no chat host, or a pane this host no longer places, is a closed conversation.
    isConversationOpen: (source) =>
      source.kind === 'structured'
        ? Boolean(
            getStructuredAgentSessionHost()
              ?.liveSessionStatusSummaries()
              .some((entry) => entry.sessionId === source.sessionId)
          )
        : resolveWorktreeId(source.paneKey) === source.worktreeId,
    listPromptQueues: () => runtime.listPromptQueues(),
    withdrawQueued: (source, entryId, reason) => {
      const queue = runtime.settlePromptQueueEntry(conversationSourceRowKey(source), entryId, {
        state: 'failed',
        reason
      })
      return (
        queue?.entries.some((entry) => entry.id === entryId && entry.state === 'failed') ?? false
      )
    }
  })
  // Before any drain: an automatic prompt an earlier process queued is never sent.
  controller.withdrawStaleEntries()
  keepGoing = controller
  setNextStepKeepGoingController(controller)
  // Every turn signal also marks its conversation as used, so it can never take suggested starts.
  const forward = (signal: TurnSignal): void => {
    if (signal.kind === 'finished') {
      jev.noteTurn(signal.turn)
      const { paneKey } = signal.turn.conversation
      const apiOrigin = runtime.getArtifactApiOrigin()
      linkedDocs.noteReply(paneKey, signal.turn.lastAssistantMessage, apiOrigin)
      options.onReplyDocuments?.(paneKey, signal.turn.lastAssistantMessage, apiOrigin)
    }
    noteNextStepStartActivity(next, signal)
    next.onTurnSignal(signal)
    emitNextStepTurnSignal(signal)
  }
  // Revoke the old turn before forwarding an event that may capture a new transfer checkpoint.
  const stopWriteFences = followConversationChangesForWriteFences({
    subscribeHookReports: (listener) => agentHookServer.subscribeEnrichedStatus(listener),
    subscribeTurnSignals: onNextStepTurnSignal,
    getHost: getStructuredAgentSessionHost,
    subscribeHostChanges: subscribeStructuredAgentSessionHost
  })
  const unsubscribeHooks = agentHookServer.subscribeEnrichedStatus((event) => {
    const signal = classifyHookTurnSignal(event, resolveWorktreeId)
    // Keep going reads the turn first, so a person's own message stops it before a new round.
    controller.onTurnSignal(signal, hookRowAttention(event.payload))
    forward(signal)
  })
  const unsubscribeTeardown = registerPaneKeyTeardownListener((paneKey) => {
    controller.onPaneClosed(paneKey)
    next.onPaneClosed(paneKey)
  })
  const stopStructured = followStructuredTurns({
    getHost: getStructuredAgentSessionHost,
    subscribeHostChanges: subscribeStructuredAgentSessionHost,
    onSignal: (signal) => {
      const conversation =
        signal.kind === 'finished'
          ? signal.turn.conversation
          : signal.kind === 'ignore'
            ? undefined
            : signal.conversation
      const attention = conversation
        ? readChatAttention(getStructuredAgentSessionHost(), conversation)
        : null
      controller.onTurnSignal(signal, attention)
      forward(signal)
    }
  })
  const stopChatAttention = followChatAttention({
    getHost: getStructuredAgentSessionHost,
    subscribeHostChanges: subscribeStructuredAgentSessionHost,
    onAttention: (conversation, attention) => controller.onAttention(conversation, attention)
  })
  // Quit: stop listening, then let every started write land. A set still generating is
  // saved as such and reads back as "interrupted" on the next launch.
  return () => {
    unsubscribeHooks()
    stopWriteFences()
    unsubscribeTeardown()
    stopStructured()
    stopChatAttention()
    keepGoing = null
    if (getNextStepKeepGoingController() === controller) {
      setNextStepKeepGoingController(null)
    }
    if (getNextStepSuggestionService() === next) {
      setNextStepSuggestionService(null)
    }
    jev.attach(null)
    if (getSessionLinkedDocsStore() === linkedDocs) {
      setSessionLinkedDocsStore(null)
    }
    if (getNextStepJev() === jev) {
      setNextStepJev(null)
    }
    return Promise.all([suggestionStore.flush(), keepGoingStore.flush(), linkedDocs.flush()]).then(
      () => undefined
    )
  }
}
