import { hostname } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { getProfileUserDataPath } from '../../omni-profiles/profile-storage-paths'
import type { AgentType, NativeChatMessage } from '../../../shared/native-chat-types'
import type { OrcaRuntimeService } from '../omni-runtime'
import type { OrchestrationWorkerResumeManifest } from '../../../shared/orchestration-worker-output'
import { OrchestrationError } from './orchestration-error'
import {
  MAX_WORKER_TRANSCRIPT_MESSAGE_LIMIT,
  redactWorkerTerminalLines
} from './worker-transcript-payload'
import { readWorkerTranscript } from './worker-transcript-read'

// Bound the durable copy of raw terminal output; the tail end is the evidence that matters.
const TERMINAL_ARCHIVE_MAX_CHARS = 262_144

export type WorkerTranscriptPinArchive = {
  agent: AgentType
  providerSessionKey: string
  providerSessionId: string
  transcriptPath: string | null
  processIncarnation: string
  observedAfter: number
  endOffset?: number
}

export type WorkerTranscriptSnapshotArchive = {
  version: 2
  resume?: OrchestrationWorkerResumeManifest
  agent: AgentType
  processIncarnation: string
  messages: NativeChatMessage[]
  limited: boolean
  warnings: string[]
}

export type WorkerTerminalTailArchive = {
  resume?: OrchestrationWorkerResumeManifest
  lines: string[]
  draft?: string
  truncated: boolean
  terminalStatus: string
  warnings: string[]
}

export type WorkerOutputArchiveCapture =
  | {
      kind: 'transcript_pin'
      content: WorkerTranscriptSnapshotArchive
      status: 'captured'
    }
  | { kind: 'terminal_tail'; content: WorkerTerminalTailArchive; status: 'captured' | 'empty' }

// Freezes an inspectable output source before the live PTY is closed. Prefers the exact
// hook-reported provider transcript; falls back to bounded redacted terminal output. Throws
// typed archive_failed so release retains the live terminal when no evidence can be preserved.
export async function captureWorkerOutputArchive(args: {
  runtime: OrcaRuntimeService
  dispatchId: string
  terminalHandle: string
  attachedAtMs: number
  resumeContext?: { hostScope: string; worktreeId: string; accountChoiceId: string | null }
  requireResume?: boolean
}): Promise<WorkerOutputArchiveCapture> {
  const session = args.runtime.getExactWorkerProviderSession(args.terminalHandle, args.attachedAtMs)
  const resume: OrchestrationWorkerResumeManifest | undefined = session
    ? {
        agent: session.agent,
        providerSessionKey: session.providerSession.key,
        providerSessionId: session.providerSession.id,
        transcriptPath: session.providerSession.transcriptPath ?? null,
        processIncarnation: session.processIncarnation
      }
    : undefined
  const assertResumeIdentity = (): void => {
    if (!resume) {
      return
    }
    const current = args.runtime.getExactWorkerProviderSession(
      args.terminalHandle,
      args.attachedAtMs
    )
    if (
      !current ||
      current.processIncarnation !== resume.processIncarnation ||
      current.agent !== resume.agent ||
      current.providerSession.key !== resume.providerSessionKey ||
      current.providerSession.id !== resume.providerSessionId ||
      (current.providerSession.transcriptPath ?? null) !== resume.transcriptPath
    ) {
      throw new OrchestrationError(
        'archive_failed',
        `Provider identity changed while preserving Dispatch ${args.dispatchId}; the terminal was retained.`
      )
    }
  }
  if (resume && session && args.resumeContext) {
    const marker =
      session.agent === 'claude' ? '/projects/' : session.agent === 'codex' ? '/sessions/' : null
    const transcript = session.providerSession.transcriptPath?.replaceAll('\\', '/')
    const offset = marker && transcript ? transcript.lastIndexOf(marker) : -1
    const accountHome = offset > 0 ? transcript!.slice(0, offset) : null
    const hook = args.runtime.getLastAgentHookRowForPane(session.paneKey)
    const launch = args.runtime.getAgentStatusLaunchConfigForPaneKey(session.paneKey, {
      launchToken: hook?.launchToken
    })
    const launchHome =
      launch?.agentEnv[session.agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']
    if (
      accountHome &&
      isAbsolute(accountHome) &&
      (!launchHome || resolve(launchHome) === resolve(accountHome))
    ) {
      const worktreePath = await args.runtime
        .resolveConversationCapacityWorkspace({
          kind: 'pty',
          worktreeId: args.resumeContext.worktreeId,
          paneKey: session.paneKey
        })
        .catch(() => null)
      if (worktreePath) {
        resume.execution = {
          ...args.resumeContext,
          hostname: hostname(),
          profilePath: getProfileUserDataPath(),
          worktreePath,
          accountHome
        }
      }
    }
    assertResumeIdentity()
  }
  if (args.requireResume && !resume?.execution) {
    throw new OrchestrationError(
      'archive_failed',
      `Exact provider account and workspace resume context is unavailable for Dispatch ${args.dispatchId}; the worker was retained.`
    )
  }
  if (session) {
    const snapshot = await readWorkerTranscript({
      agent: session.agent,
      sessionId: session.providerSession.id,
      transcriptPath: session.providerSession.transcriptPath,
      limit: MAX_WORKER_TRANSCRIPT_MESSAGE_LIMIT
    }).catch(() => null)
    if (snapshot?.ok && snapshot.messages.length > 0) {
      assertResumeIdentity()
      return {
        kind: 'transcript_pin',
        status: 'captured',
        content: {
          version: 2,
          resume,
          agent: session.agent,
          processIncarnation: session.processIncarnation,
          messages: snapshot.messages,
          limited: snapshot.limited,
          warnings: snapshot.warnings
        }
      }
    }
  }
  let terminal
  try {
    terminal = await args.runtime.readTerminal(args.terminalHandle, {})
  } catch (error) {
    throw new OrchestrationError(
      'archive_failed',
      `Output could not be preserved for Dispatch ${args.dispatchId}; the terminal was retained. ${error instanceof Error ? error.message : String(error)}`
    )
  }
  assertResumeIdentity()
  const redacted = redactWorkerTerminalLines([
    ...terminal.tail,
    ...(terminal.draft ? [terminal.draft] : [])
  ])
  const bounded = boundArchiveLines(redacted.lines)
  const draft = terminal.draft ? bounded.lines.at(-1) : undefined
  const lines = terminal.draft ? bounded.lines.slice(0, -1) : bounded.lines
  // Why: an exited PTY zeroes its tail immediately, so an empty capture is a distinct receipt,
  // not silent success — worker-read must be able to say why nothing is there.
  const empty = bounded.lines.every((line) => line.trim() === '')
  return {
    kind: 'terminal_tail',
    status: empty ? 'empty' : 'captured',
    content: {
      ...(resume ? { resume } : {}),
      lines,
      ...(draft ? { draft } : {}),
      truncated: terminal.truncated || bounded.truncated,
      terminalStatus: terminal.status,
      warnings: empty
        ? [
            ...redacted.warnings,
            'The live terminal buffer was empty at release; structured transcript output was unavailable.'
          ]
        : redacted.warnings
    }
  }
}

function boundArchiveLines(lines: string[]): { lines: string[]; truncated: boolean } {
  let total = 0
  for (const line of lines) {
    total += line.length + 1
  }
  if (total <= TERMINAL_ARCHIVE_MAX_CHARS) {
    return { lines, truncated: false }
  }
  const kept: string[] = []
  let budget = TERMINAL_ARCHIVE_MAX_CHARS
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const cost = lines[index].length + 1
    if (cost > budget) {
      if (kept.length === 0 && budget > 1) {
        kept.unshift(lines[index].slice(-(budget - 1)))
      }
      break
    }
    kept.unshift(lines[index])
    budget -= cost
  }
  return { lines: kept, truncated: true }
}
