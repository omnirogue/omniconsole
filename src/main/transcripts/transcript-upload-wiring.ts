import { hostname } from 'node:os'
import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'
import { resolveNativeChatTranscriptAgent } from '../../shared/native-chat-agent-support'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import { agentHookServer } from '../agent-hooks/server'
import { reportAppHealth } from '../app-health/app-health'
import {
  captureTranscriptPrincipal,
  currentTranscriptOwner,
  uploadEmployeeTranscript
} from '../backoffice/console-employee-transcript-client'
import { isElectronOmniConsoleMcpSignedIn } from '../host/electron-omni-console-mcp-auth'
import { registerPaneKeyTeardownListener } from '../ipc/pty/pane/key-state'
import { buildSessionTranscript } from './session-transcript-deliverable'
import { TranscriptSequenceStore } from './transcript-sequence-store'
import { TranscriptUploader } from './transcript-uploader'

/** A turn ended: the session goes on, so this is a checkpoint. */
const TURN_END_EVENTS = new Set(['Stop', 'StopFailure', 'SubagentStop', 'stop'])
/** The agent itself ended, even if its shell pane stays open: this is the final. */
const SESSION_END_EVENTS = new Set(['SessionEnd', 'session_end'])
/** Agents that report a session id but whose transcript this reader cannot decode
 *  yet (Gemini). The gap is reported once per session rather than skipped silently. */
const UNSUPPORTED_TRANSCRIPT_AGENTS = new Set(['gemini'])

let uploader: TranscriptUploader | null = null
let unsubscribe: (() => void) | null = null

function signedIn(): boolean {
  try {
    return isElectronOmniConsoleMcpSignedIn()
  } catch {
    return false
  }
}

export function transcriptUploader(): TranscriptUploader {
  uploader ??= new TranscriptUploader({
    isSignedIn: signedIn,
    build: (source, signal) => buildSessionTranscript(source, signal),
    upload: (body, options) => uploadEmployeeTranscript(body, options),
    reportHealth: reportAppHealth,
    currentOwner: currentTranscriptOwner,
    capturePrincipal: captureTranscriptPrincipal,
    appVersion: () => (hasAppEnvironment() ? getAppEnvironment().getVersion() : 'unknown'),
    host: () => hostname(),
    sequences: new TranscriptSequenceStore(
      hasAppEnvironment() ? getAppEnvironment().getPath('userData') : null
    )
  })
  return uploader
}

/**
 * The trigger points, all on this host's own sessions:
 *  - every accepted hook status with a provider session → the session is observed;
 *    a Stop / SubagentStop / session_end (or a `done` state) schedules a checkpoint;
 *  - PTY exit and tab close both funnel through `clearProviderPtyState`, whose
 *    pane-key teardown fan-out is the `final` upload;
 *  - quit is `finalizeTranscriptUploadsForQuit`, bounded by the will-quit deadline.
 * Sessions on an SSH connection are skipped: their transcript lives on the other host.
 */
export function startTranscriptUploads(options: {
  resolveWorktreeId?: (paneKey: string) => string | null
}): () => void {
  if (unsubscribe) {
    return unsubscribe
  }
  const target = transcriptUploader()
  const reportedUnsupported = new Set<string>()
  const unsubscribeStatus = agentHookServer.subscribeEnrichedStatus((enriched) => {
    if (enriched.connectionId !== null || enriched.isReplay || enriched.restoredUnconfirmed) {
      return
    }
    const providerSession = enriched.providerSession
    const agentType = enriched.payload.agentType
    if (!providerSession || !agentType) {
      return
    }
    if (!resolveNativeChatTranscriptAgent(agentType)) {
      const key = `${agentType}\u0000${providerSession.id}`
      if (UNSUPPORTED_TRANSCRIPT_AGENTS.has(agentType) && !reportedUnsupported.has(key)) {
        reportedUnsupported.add(key)
        reportAppHealth({
          feature: 'transcript_upload',
          status: 'error',
          code: 'unsupported_agent',
          message: `${agentType} session ${providerSession.id}`
        })
      }
      return
    }
    const worktreeId = enriched.worktreeId ?? options.resolveWorktreeId?.(enriched.paneKey) ?? null
    const cwd = worktreeId ? (splitWorktreeIdForFilesystem(worktreeId)?.worktreePath ?? null) : null
    target.observe({
      sessionKey: enriched.paneKey,
      agent: agentType,
      sessionId: providerSession.id,
      ...(providerSession.transcriptPath ? { transcriptPath: providerSession.transcriptPath } : {}),
      model: enriched.payload.model ?? null,
      cwd
    })
    const event = enriched.hookEventName
    if (event !== undefined && SESSION_END_EVENTS.has(event)) {
      void target.final(enriched.paneKey)
      return
    }
    if ((event !== undefined && TURN_END_EVENTS.has(event)) || enriched.payload.state === 'done') {
      target.scheduleCheckpoint(enriched.paneKey)
    }
  })
  const unsubscribeTeardown = registerPaneKeyTeardownListener((paneKey) => {
    void target.final(paneKey)
  })
  unsubscribe = () => {
    unsubscribeStatus()
    unsubscribeTeardown()
    unsubscribe = null
  }
  return unsubscribe
}

/** Every live session's final snapshot; the will-quit deadline bounds the wait. */
export function finalizeTranscriptUploadsForQuit(): Promise<void> {
  return uploader ? uploader.finalizeAll() : Promise.resolve()
}
