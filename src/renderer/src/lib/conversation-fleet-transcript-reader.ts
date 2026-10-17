import { capturePickedHandoffFile } from '@/components/handoffs/handoff-client'
import { callRuntimeRpc, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import {
  transcriptDeliverableRpcResult,
  transcriptErrorMessage,
  TRANSCRIPT_ERROR_CODES
} from '../../../shared/conversation-transcript-deliverable'
import type { ExactHandoffFile } from '../../../shared/console-handoff-contract'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { hasRuntimeRpcErrorCode } from '../../../shared/runtime-rpc-error-code'

export type ConversationFleetTranscriptSource = {
  kind?: 'provider' | 'structured'
  hostId: ExecutionHostId
  runtimeEnvironmentId?: string
  agent: string
  sessionId: string
  transcriptPath?: string
  model?: string | null
}

export type ConversationFleetTranscript =
  | {
      kind: 'file'
      file: ExactHandoffFile
      messageCount: number
      earlierMessagesOmitted: boolean
      omittedRecords: number
    }
  /** The host's redaction gate refused; no transcript bytes were produced. */
  | { kind: 'refused'; redactions: number; message: string }

/** The same host resolution the source-file capture uses, so the transcript and
 *  the work files can never be read from two different machines. */
function transcriptRoute(
  hostId: ExecutionHostId,
  runtimeEnvironmentId?: string
): { target: RuntimeClientTarget; connectionId: string | null } {
  const host = parseExecutionHostId(hostId)
  if (!host) {
    throw new Error('The source conversation has no verified execution host.')
  }
  if (
    host.kind === 'runtime' &&
    runtimeEnvironmentId &&
    runtimeEnvironmentId !== host.environmentId
  ) {
    throw new Error('The source runtime changed. Prepare the dispatch again.')
  }
  const environmentId =
    runtimeEnvironmentId ?? (host.kind === 'runtime' ? host.environmentId : null)
  return {
    target: environmentId ? { kind: 'environment', environmentId } : { kind: 'local' },
    // The same identity the work-file capture pins. Carried to the host so a
    // session on another machine is refused there, not answered from whatever
    // happens to sit at the same path on the runtime box.
    connectionId: host.kind === 'ssh' ? host.targetId : null
  }
}

export function conversationTranscriptRefusalMessage(redactions: number): string {
  const values = `${redactions} value${redactions === 1 ? '' : 's'}`
  return `The transcript was not sent: it contains ${values} the redactor treats as a secret. Remove the secret from the session, or send the work files without the transcript.`
}

/**
 * Ask the source host to build the redacted transcript. The unredacted messages
 * never leave that host: this returns either a file it already proved clean, or
 * a refusal with a count and no values.
 */
export async function readConversationFleetTranscript(
  source: ConversationFleetTranscriptSource,
  capturedAt: string,
  signal: AbortSignal,
  complete = false
): Promise<ConversationFleetTranscript> {
  const { target, connectionId } = transcriptRoute(source.hostId, source.runtimeEnvironmentId)
  if (connectionId !== null && !complete) {
    // Refuse here as well as on the host: no round trip, and the person is told
    // why before the dispatch rather than after it.
    throw new Error(transcriptErrorMessage(TRANSCRIPT_ERROR_CODES.remoteHostUnsupported))
  }
  if (complete && !source.kind) {
    throw new Error('The complete history source has no verified session kind.')
  }
  signal.throwIfAborted()
  // try/catch, not `.catch`: a transport that throws synchronously must be
  // classified the same as one that rejects.
  let answer: unknown
  try {
    answer = await callRuntimeRpc(
      target,
      complete ? 'transcripts.buildCompleteDeliverable' : 'transcripts.buildDeliverable',
      {
        agent: source.agent,
        sessionId: source.sessionId,
        capturedAt,
        expectedConnectionId: connectionId,
        ...(source.transcriptPath ? { transcriptPath: source.transcriptPath } : {}),
        ...(complete ? { kind: source.kind } : source.model ? { model: source.model } : {})
      },
      { signal, timeoutMs: 60_000 }
    )
  } catch (error) {
    if (hasRuntimeRpcErrorCode(error, 'method_not_found')) {
      throw new Error(
        'Update Orca on the source host and reconnect it to send this conversation’s transcript.'
      )
    }
    throw error
  }
  const result = transcriptDeliverableRpcResult.parse(answer)
  if ('error' in result) {
    throw new Error(transcriptErrorMessage(result.error, result.sizeBytes))
  }
  if ('reason' in result) {
    return {
      kind: 'refused',
      redactions: result.redactions,
      message: conversationTranscriptRefusalMessage(result.redactions)
    }
  }
  if (
    complete &&
    (result.earlierMessagesOmitted || result.omittedRecords !== 0 || result.truncatedBlocks !== 0)
  ) {
    throw new Error(transcriptErrorMessage(TRANSCRIPT_ERROR_CODES.incomplete))
  }
  const binary = atob(result.contentBase64)
  if (btoa(binary) !== result.contentBase64 || binary.length !== result.size) {
    throw new Error('The source host returned incomplete transcript bytes. Try the handoff again.')
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  const file = await capturePickedHandoffFile(new File([bytes], result.name))
  if (file.sha256 !== result.sha256 || file.size !== result.size) {
    throw new Error('The captured transcript failed verification. Try the handoff again.')
  }
  return {
    kind: 'file',
    file,
    messageCount: result.messageCount,
    earlierMessagesOmitted: result.earlierMessagesOmitted,
    omittedRecords: result.omittedRecords
  }
}
