import { stat } from 'node:fs/promises'
import { LOCAL_LOG_TAIL_CHUNK_BYTES } from '../../shared/local-log-tail-types'
import { localLogFileIdentity, readLocalLogTailRange } from '../ai-vault/local-log-tail-reader'
import { asRecord, parseJsonObject } from '../ai-vault/session-scanner-values'

function actualModel(value: unknown): string | undefined {
  return typeof value === 'string' &&
    /^[a-z0-9][a-z0-9._:/[\]-]{0,511}$/i.test(value) &&
    value !== 'default' &&
    value !== 'auto'
    ? value
    : undefined
}

function latestClaudeTurnModel(content: string, sessionId: string): string | undefined {
  // An unfinished final record may be the failure or a model switch.
  if (!content.endsWith('\n')) {
    return undefined
  }
  const lines = content.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim()
    if (!line) {
      continue
    }
    const record = parseJsonObject(line)
    if (!record) {
      return undefined
    }
    if (
      record.sessionId !== sessionId ||
      record.isSidechain === true ||
      record.parent_tool_use_id != null
    ) {
      continue
    }
    if (record.type === 'user' || record.type === 'system' || record.type === 'model_change') {
      return undefined
    }
    if (record.type === 'assistant') {
      const message = asRecord(record.message)
      // Synthetic failures may follow a real reply, but cannot borrow across a turn boundary.
      if (record.isApiErrorMessage === true || message?.model === '<synthetic>') {
        continue
      }
      return actualModel(message?.model)
    }
  }
  return undefined
}

/** Capture once during preparation; startup defaults cannot prove a native /model selection. */
export async function resolveCapacityRecoverySourceModel(input: {
  agent: 'claude' | 'codex'
  model?: string
  providerSessionId: string
  transcriptPath: string
}): Promise<string | undefined> {
  const observedModel = actualModel(input.model)
  if (observedModel || input.agent !== 'claude') {
    return observedModel
  }
  try {
    const stats = await stat(input.transcriptPath)
    if (!stats.isFile()) {
      return undefined
    }
    const start = Math.max(0, stats.size - LOCAL_LOG_TAIL_CHUNK_BYTES)
    const tail = await readLocalLogTailRange(
      input.transcriptPath,
      start,
      localLogFileIdentity(stats)
    )
    if (tail.reset || tail.hasMore || tail.fileSize !== stats.size) {
      return undefined
    }
    const content = Buffer.from(tail.contentBase64, 'base64').toString('utf8')
    const complete = start > 0 ? content.slice(content.indexOf('\n') + 1) : content
    return start > 0 && !content.includes('\n')
      ? undefined
      : latestClaudeTurnModel(complete, input.providerSessionId)
  } catch {
    return undefined
  }
}
