import { capturePickedHandoffFile } from '@/components/handoffs/handoff-client'
import { callRuntimeRpc, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import {
  captureFleetSourceResult,
  readFleetSourceChunkResult,
  type CapturedFleetSourceFile,
  type CaptureFleetSourceRequest
} from '../../../shared/conversation-fleet-source-snapshot'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import type { ExactHandoffFile } from '../../../shared/console-handoff-contract'
import { hasRuntimeRpcErrorCode } from '../../../shared/runtime-rpc-error-code'

export type ConversationFleetCapturedFile = {
  file: ExactHandoffFile
  targetPath: string
  executable: boolean
}

async function readCapturedFile(
  target: RuntimeClientTarget,
  snapshotId: string,
  file: CapturedFleetSourceFile,
  signal: AbortSignal
): Promise<ConversationFleetCapturedFile> {
  const parts: Uint8Array<ArrayBuffer>[] = []
  let offset = 0
  while (true) {
    signal.throwIfAborted()
    const result = readFleetSourceChunkResult.parse(
      await callRuntimeRpc(
        target,
        'files.readFleetSourceChunk',
        {
          snapshotId,
          fileId: file.id,
          offset
        },
        { signal, timeoutMs: 30_000 }
      )
    )
    const binary = atob(result.contentBase64)
    if (
      btoa(binary) !== result.contentBase64 ||
      result.nextOffset !== offset + binary.length ||
      result.nextOffset > file.size ||
      (result.complete
        ? result.nextOffset !== file.size
        : result.nextOffset <= offset || result.nextOffset === file.size)
    ) {
      throw new Error('The source host returned incomplete file bytes. Capture the files again.')
    }
    parts.push(Uint8Array.from(binary, (char) => char.charCodeAt(0)))
    offset = result.nextOffset
    if (result.complete) {
      break
    }
  }
  const captured = await capturePickedHandoffFile(new File(parts, file.name))
  if (captured.sha256 !== file.sha256 || captured.size !== file.size) {
    throw new Error(
      `The captured version of ${file.targetPath} failed verification. Capture the files again.`
    )
  }
  return { file: captured, targetPath: file.targetPath, executable: file.executable }
}

export async function readConversationFleetSource(
  hostId: ExecutionHostId,
  request: CaptureFleetSourceRequest,
  signal: AbortSignal,
  runtimeEnvironmentId?: string
) {
  const host = parseExecutionHostId(hostId)
  if (!host) {
    throw new Error('The source files have no verified execution host.')
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
  const target: RuntimeClientTarget = environmentId
    ? { kind: 'environment', environmentId }
    : { kind: 'local' }
  const connectionId = host.kind === 'ssh' ? host.targetId : null
  signal.throwIfAborted()
  const snapshot = captureFleetSourceResult.parse(
    await callRuntimeRpc(
      target,
      'files.captureFleetSource',
      {
        ...request,
        expectedConnectionId: connectionId
      },
      { signal, timeoutMs: 60_000 }
    ).catch((error: unknown) => {
      if (hasRuntimeRpcErrorCode(error, 'method_not_found')) {
        throw new Error(
          'Update Orca on the source host and reconnect it to capture this conversation’s work files.'
        )
      }
      throw error
    })
  )
  try {
    if (snapshot.source.connectionId !== connectionId) {
      throw new Error('The source file response did not verify the selected execution host.')
    }
    const files: ConversationFleetCapturedFile[] = []
    for (const file of snapshot.files) {
      files.push(await readCapturedFile(target, snapshot.snapshotId, file, signal))
    }
    signal.throwIfAborted()
    return { ...snapshot, files }
  } finally {
    // The host also expires abandoned snapshots; release must work after cancellation.
    await callRuntimeRpc(
      target,
      'files.releaseFleetSource',
      { snapshotId: snapshot.snapshotId },
      { timeoutMs: 10_000 }
    ).catch(() => undefined)
  }
}
