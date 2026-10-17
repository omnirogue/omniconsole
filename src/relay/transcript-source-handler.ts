import {
  SSH_OMP_CHAT_METHOD,
  SSH_OMP_CHAT_CAPABILITY,
  sshOmpChatRequest
} from '../shared/ssh-native-chat'
import { readNativeChatTranscriptTail } from '../main/native-chat/transcript-tail-reader'
import { isAiVaultScanCancelledError, type AiVaultListResult } from '../shared/ai-vault-types'
import {
  findIndexedTranscriptSource,
  TranscriptSourceIndexError,
  validateIndexedTranscriptIdentity,
  type IndexedTranscriptSource
} from '../main/native-chat/indexed-transcript-source'
import type { RelayAiVaultServiceApi } from './ai-vault-service-client-state'
import type { RelayDispatcher } from './dispatcher'

export class TranscriptSourceHandler {
  constructor(dispatcher: RelayDispatcher, options: { service?: RelayAiVaultServiceApi } = {}) {
    dispatcher.onRequest(SSH_OMP_CHAT_METHOD, async (params, context) => {
      const request = sshOmpChatRequest.parse(params)
      const source = await resolveSource(options.service, request, context.signal, false)
      const result = source
        ? await readNativeChatTranscriptTail(
            { ...request, filePath: source.filePath },
            context.signal
          )
        : { error: 'Transcript unavailable on its owning host.', notFound: true }
      return {
        capability: SSH_OMP_CHAT_CAPABILITY,
        agent: request.agent,
        sessionId: request.sessionId,
        result:
          Buffer.byteLength(JSON.stringify(result)) > 4 * 1024 * 1024
            ? { error: 'SSH OMP transcript window exceeds the relay read limit.' }
            : result
      }
    })
    dispatcher.onRequest('transcript.resolveSource', (params, context) =>
      resolveSource(options.service, params, context.signal)
    )
  }
}

async function resolveSource(
  service: RelayAiVaultServiceApi | undefined,
  params: Record<string, unknown>,
  signal?: AbortSignal,
  force = true
): Promise<IndexedTranscriptSource | null> {
  signal?.throwIfAborted()
  const identity = validateIndexedTranscriptIdentity(params.agent, params.sessionId)
  if (!service) {
    throw new TranscriptSourceIndexError('the owning host session service is unavailable')
  }
  let result: AiVaultListResult
  try {
    result = await service.listSessions({ unlimited: true, force }, signal)
  } catch (error) {
    signal?.throwIfAborted()
    if (isAiVaultScanCancelledError(error)) {
      throw error
    }
    throw new TranscriptSourceIndexError('the owning host session service did not answer')
  }
  signal?.throwIfAborted()
  return findIndexedTranscriptSource(result, identity.agent, identity.sessionId)
}
