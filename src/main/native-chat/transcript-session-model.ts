import type { AgentType } from '../../shared/native-chat-types'
import { isPiFamilyTranscriptAgent } from '../../shared/native-chat-agent-support'
import { parseNativeChatSessionModel } from '../../shared/native-chat-session-model'
import { asRecord, parseJsonObject } from '../ai-vault/session-scanner-values'

export type NativeChatSessionModelDecoder = (line: string) => string | undefined

export function nativeChatSessionModelDecoderForAgent(
  agent: AgentType
): NativeChatSessionModelDecoder | undefined {
  return isPiFamilyTranscriptAgent(agent) ? decodePiSessionModel : undefined
}

export function decodePiSessionModel(line: string): string | undefined {
  const record = parseJsonObject(line)
  const message = record?.type === 'message' ? asRecord(record.message) : null
  const source =
    record?.type === 'model_change' ? record : message?.role === 'assistant' ? message : null
  if (!source) {
    return undefined
  }
  // OMP records a fully qualified selector without a separate provider on model changes.
  if (record?.type === 'model_change' && source.provider === undefined) {
    return parseNativeChatSessionModel(source.model)
  }
  if (typeof source.provider !== 'string') {
    return undefined
  }
  const model = source.modelId ?? source.model
  return typeof model === 'string'
    ? parseNativeChatSessionModel(`${source.provider}/${model}`)
    : undefined
}
