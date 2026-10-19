/**
 * Starts the turn-end deliverable check on this host: every finished turn the next-step classifier
 * emits (hook-reported PTY agents and chat sessions alike) is checked where its workspace lives.
 */

import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { conversationSourceRowKey } from '../../shared/conversation-source'
import { normalizeDeliverableVerifierSettings } from '../../shared/deliverable-verifier-settings'
import { agentHookServer } from '../agent-hooks/server'
import { listArtifactSessionRecords } from '../artifacts/artifact-session-records'
import { getSessionWrittenFilesStore } from '../artifacts/session-written-files-store'
import { registerPaneKeyTeardownListener } from '../ipc/pty/pane/key-state'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { hookRowAttention, readChatAttention } from '../next-steps/next-step-keep-going-feeds'
import {
  getNextStepKeepGoingController,
  onNextStepTurnSignal
} from '../next-steps/next-step-suggestion-slot'
import { resolveNextStepWorkspace } from '../next-steps/next-step-workspace'
import type { Store } from '../persistence'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { isChainBoundToConversation } from '../runtime/conversation-chain-ownership'
import { readDeliveredFile } from '../runtime/delivered-file-read'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { enqueueConversationPrompt } from '../runtime/prompt-queue-enqueue'
import { getSessionDecisionStore } from '../session-questions/session-decision-wiring'
import { DeliverableVerificationStore } from './deliverable-verification-store'
import { DeliverableVerifierService } from './deliverable-verifier-service'
import { getDeliverableVerifier, setDeliverableVerifier } from './deliverable-verifier-slot'

export function startDeliverableVerifier(options: {
  store: Store
  runtime: OrcaRuntimeService
  userDataPath: string
}): () => Promise<void> {
  const { store, runtime, userDataPath } = options
  const records = new DeliverableVerificationStore({ directory: userDataPath })
  records.load()
  const service = new DeliverableVerifierService({
    settings: () =>
      normalizeDeliverableVerifierSettings(store.getSettings().deliverableVerifier, process.env),
    store: records,
    now: () => Date.now(),
    schedule: (run, ms) => {
      const timer = setTimeout(run, ms)
      return () => clearTimeout(timer)
    },
    resolveWorkspace: (worktreeId) => resolveNextStepWorkspace(store, worktreeId),
    hostLabel: (connectionId) => (connectionId ? 'the SSH host' : 'this computer'),
    home: () => homedir(),
    // Why: APFS and NTFS default to case-insensitive; a remote POSIX host is assumed not to be.
    caseInsensitive: (style, connectionId) =>
      style === 'win32' || (!connectionId && process.platform === 'darwin'),
    readLocalFile: readDeliveredFile,
    readLocalDirectory: async (path) => {
      try {
        return (await readdir(path)).length
      } catch {
        return null
      }
    },
    statRemote: (connectionId) => {
      const provider = getSshFilesystemProvider(connectionId)
      return provider
        ? async (path) => {
            const info = await provider.stat(path)
            return {
              size: info.size,
              isDirectory: info.type === 'directory',
              mtime: info.mtimeMs ?? info.mtime
            }
          }
        : null
    },
    writtenPaths: (paneKey) =>
      getSessionWrittenFilesStore()
        ?.listByPane()
        .find((entry) => entry.paneKey === paneKey)?.paths ?? [],
    sharedUrls: (paneKey, since) => {
      try {
        return listArtifactSessionRecords(userDataPath)
          .filter(
            (record) =>
              record.origin?.paneKey === paneKey &&
              (since === null || (record.savedAt ?? 0) >= since)
          )
          .map((record) => record.shareUrl)
      } catch {
        return []
      }
    },
    isChainBound: (source) => isChainBoundToConversation(runtime, source),
    isKeepGoingOn: (source) =>
      getNextStepKeepGoingController()?.list({ conversation: source })[0]?.enabled === true,
    agentWaiting: (source) => {
      if (source.kind === 'structured') {
        return readChatAttention(getStructuredAgentSessionHost(), source) !== null
      }
      const row = agentHookServer.getStatusSnapshotForPane(source.paneKey)[0]
      return row ? hookRowAttention(row) !== null : false
    },
    pendingQuestion: (paneKey) =>
      getSessionDecisionStore()
        ?.list()
        .some((record) => record.paneKey === paneKey && record.endedAt === null) ?? false,
    readQueue: (source) => runtime.readPromptQueue(conversationSourceRowKey(source)),
    enqueue: (source, input) => {
      enqueueConversationPrompt(runtime, source, input)
    }
  })
  setDeliverableVerifier(service)
  const stopTurns = onNextStepTurnSignal((signal) => service.onTurnSignal(signal))
  const stopTeardown = registerPaneKeyTeardownListener((paneKey) => service.onPaneClosed(paneKey))
  return () => {
    stopTurns()
    stopTeardown()
    if (getDeliverableVerifier() === service) {
      setDeliverableVerifier(null)
    }
    return records.flush()
  }
}
