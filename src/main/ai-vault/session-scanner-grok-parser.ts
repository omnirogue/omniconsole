import { openTranscriptReadStream, wslGatedReadFile } from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import { remoteSessionContentLines } from './remote-session-content-lines'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import type { FileWithMtime, SessionAccumulator } from './session-scanner-types'
import {
  addPreviewMessage,
  createAccumulator,
  finalizeSession,
  sessionIdFromFileName,
  updateTimeline
} from './session-scanner-accumulator'
import {
  normalizeFullFirstUserPromptText,
  shouldCaptureFullFirstUserPrompt
} from './session-scanner-first-user-prompt'
import {
  extractGrokFirstUserPromptText,
  stripGrokUserQueryEnvelope
} from './session-scanner-grok-user-text'
import {
  asRecord,
  extractPreviewContentText,
  extractString,
  normalizePreviewText,
  normalizeTitleText,
  numberValue,
  parseJsonObject,
  sliceAtCodeUnitLimit
} from './session-scanner-values'

const GROK_USER_QUERY_PREVIEW_SCAN_LIMIT = 4096

type ParserSessionOptions = {
  executionHostId?: ExecutionHostId
  executionHostPlatform?: NodeJS.Platform | null
}

export async function parseGrokSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform
): Promise<AiVaultSession | null> {
  const accumulator = createGrokSessionAccumulator(
    file,
    await wslGatedReadFile(file.path, 'utf-8', 'scan')
  )
  if (!accumulator) {
    return null
  }
  await consumeGrokChatHistory(accumulator, dirname(file.path))
  return finalizeSession(accumulator, platform)
}

export async function parseGrokSessionContent(
  file: FileWithMtime,
  summaryContent: string,
  historyContent: string | null,
  platform: NodeJS.Platform = process.platform,
  options: ParserSessionOptions = {},
  signal?: AbortSignal
): Promise<AiVaultSession | null> {
  throwIfAiVaultScanCancelled(signal)
  const accumulator = createGrokSessionAccumulator(file, summaryContent)
  if (!accumulator) {
    return null
  }
  if (historyContent !== null) {
    for await (const line of remoteSessionContentLines(historyContent, signal)) {
      consumeGrokHistoryLine(accumulator, line)
    }
  }
  throwIfAiVaultScanCancelled(signal)
  return finalizeSession(accumulator, platform, options)
}

function createGrokSessionAccumulator(
  file: FileWithMtime,
  summaryContent: string
): SessionAccumulator | null {
  const record = asRecord(JSON.parse(summaryContent) as unknown)
  if (!record) {
    return null
  }
  const info = asRecord(record.info)
  const sessionDir = file.path.replace(/\\/g, '/').split('/').slice(0, -1).join('/')
  const sessionId = extractString(info?.id) ?? sessionIdFromFileName(sessionDir)
  const accumulator = createAccumulator({ agent: 'grok', file, sessionId })
  accumulator.cwd = extractString(info?.cwd)
  accumulator.title =
    normalizeTitleText(extractString(record.generated_title) ?? '') ??
    normalizeTitleText(extractString(record.session_summary) ?? '')
  accumulator.model = extractString(record.current_model_id)
  accumulator.branch = extractString(record.head_branch)
  accumulator.messageCount =
    numberValue(record.num_chat_messages) || numberValue(record.num_messages)
  updateTimeline(accumulator, extractString(record.created_at))
  updateTimeline(accumulator, extractString(record.updated_at))
  updateTimeline(accumulator, extractString(record.last_active_at))
  return accumulator
}

async function consumeGrokChatHistory(
  accumulator: SessionAccumulator,
  sessionDir: string
): Promise<void> {
  const input = openTranscriptReadStream(
    join(sessionDir, 'chat_history.jsonl'),
    { encoding: 'utf-8' },
    'scan'
  )
  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      consumeGrokHistoryLine(accumulator, line)
    }
  } catch (error) {
    // Summary-only sessions still provide enough metadata for the Vault list. A
    // gate refusal is a different thing — the history exists but is unreachable,
    // so a message-less session must not be cached under the summary's mtime.
    if (error instanceof WslTranscriptFsError) {
      throw error
    }
  } finally {
    // readline.close() leaves the underlying stream open; destroy it so a
    // mid-read failure cannot leak the gated transcript handle.
    lines.close()
    input.destroy()
  }
}

function consumeGrokHistoryLine(accumulator: SessionAccumulator, line: string): void {
  const record = parseJsonObject(line)
  if (!record) {
    return
  }
  const role = extractString(record.type)
  if (role !== 'user' && role !== 'assistant') {
    return
  }
  if (role === 'user') {
    // The typed ask lives inside user_query; user_info is injected bootstrap.
    const firstPromptBody = extractGrokFirstUserPromptText(record.content)
    const text = firstPromptBody
      ? normalizePreviewText(capGrokPreviewSource(firstPromptBody))
      : null
    if (firstPromptBody) {
      accumulator.title ??= normalizeTitleText(firstPromptBody)
      if (shouldCaptureFullFirstUserPrompt() && !accumulator.firstUserPrompt) {
        accumulator.firstUserPrompt = normalizeFullFirstUserPromptText(firstPromptBody)
      }
    }
    if (text) {
      addPreviewMessage(accumulator, {
        role: 'user',
        text,
        timestamp: extractString(record.timestamp),
        seedFirstUserPrompt: false
      })
    }
    return
  }
  addPreviewMessage(accumulator, {
    role: 'assistant',
    text: extractGrokContentText(record.content),
    timestamp: extractString(record.timestamp),
    seedFirstUserPrompt: false
  })
}

export function extractGrokContentText(value: unknown): string | null {
  if (typeof value === 'string') {
    return extractGrokStringContentText(value)
  }
  return extractPreviewContentText(value)
}

function capGrokPreviewSource(text: string): string {
  return sliceAtCodeUnitLimit(text, GROK_USER_QUERY_PREVIEW_SCAN_LIMIT)
}

function extractGrokStringContentText(text: string): string | null {
  const unwrapped = stripGrokUserQueryEnvelope(text)
  return normalizePreviewText(capGrokPreviewSource(unwrapped))
}
