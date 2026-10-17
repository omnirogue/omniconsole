import { open } from 'node:fs/promises'
import type { AgentStatusState, AgentType } from '../../shared/agent-status-types'
import {
  tokenizeStartupCommand,
  type AgentStartupShell
} from '../../shared/tui-agent-startup-shell'
import { appendRecentPtyPathCandidates } from './terminal-output-path-candidates'
import { resolveSessionOutcomeSourceActor } from './session-outcome-source-actor'

export type SessionOutcomeSourceContext = {
  paneKey: string
  handle: string
  processIncarnation: string
  agent: AgentType
  model: string
  effort?: string
  summary: string
  files: string[]
}

export type TerminalOutcomeSourceInput = {
  paneKey: string
  handle: string
  processIncarnation: string
  agent: AgentType
  launchCommand?: string
  launchArgs?: string
  shell: AgentStartupShell
  transcriptPath?: string
  completionStartedAt?: number
  status: {
    state: AgentStatusState
    model?: string
    lastAssistantMessage?: string
    lastAssistantMessageIsToolOutput?: boolean
    interrupted?: boolean
    sessionBoundary?: boolean
  }
}

/** Read only a bounded tail of the exact hook-bound transcript; never discover another session. */
async function readSourceTranscriptRecords(path: string): Promise<unknown[]> {
  const file = await open(path, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile()) {
      return []
    }
    const length = Math.min(info.size, 1024 * 1024)
    const start = info.size - length
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await file.read(buffer, 0, length, start)
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/)
    if (start > 0) {
      lines.shift()
    }
    return lines.flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
  } finally {
    await file.close()
  }
}

export async function readTerminalSessionOutcomeSourceContext(
  input: TerminalOutcomeSourceInput,
  readRecords = readSourceTranscriptRecords
): Promise<SessionOutcomeSourceContext | null> {
  const { status } = input
  if (
    status.state !== 'done' ||
    status.interrupted ||
    status.sessionBoundary ||
    status.lastAssistantMessageIsToolOutput ||
    !status.lastAssistantMessage?.trim()
  ) {
    return null
  }
  const tokens = tokenizeStartupCommand(
    [input.launchCommand, input.launchArgs].filter(Boolean).join(' '),
    input.shell
  )
  const records = input.transcriptPath
    ? await readRecords(input.transcriptPath).catch(() => [])
    : []
  const actor = resolveSessionOutcomeSourceActor({
    agent: input.agent,
    ...(tokens.ok && tokens.spans.every((span) => !span.divergesFromShell)
      ? { launchArgs: tokens.tokens }
      : {}),
    observedModel: status.model,
    transcriptRecords: records
  })
  if (!actor) {
    return null
  }
  const summary = status.lastAssistantMessage.trim()
  return {
    paneKey: input.paneKey,
    handle: input.handle,
    processIncarnation: input.processIncarnation,
    ...actor,
    summary,
    files: [...new Set(appendRecentPtyPathCandidates([], summary))]
  }
}
