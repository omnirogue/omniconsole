import { parentPort, workerData } from 'node:worker_threads'
import { UsageScanStoppedError } from '../usage/usage-scan-stopped-error'
import { scanCodexUsageFiles } from './scanner'
import type { CodexUsageWorkerMessage, CodexUsageWorkerRequest } from './codex-usage-worker-protocol'

const port = parentPort!
const request = workerData as CodexUsageWorkerRequest
const send = (message: CodexUsageWorkerMessage): void => port.postMessage(message)

void scanCodexUsageFiles(request.worktrees, request.previous, {
  worktreeSetChanged: request.worktreeSetChanged,
  onCheckpoint: (processedFiles) =>
    new Promise<void>((resolve) => {
      // Bound queued snapshots and preserve checkpoint-before-completion ordering.
      port.once('message', () => resolve())
      send(
        request.checkpointState
          ? {
              type: 'checkpoint',
              snapshot: JSON.stringify({ ...request.checkpointState, processedFiles })
            }
          : { type: 'sources', sources: processedFiles }
      )
    })
}).then(
  (result) => send({ type: 'result', result }),
  (error: unknown) =>
    send({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
      stopped: error instanceof UsageScanStoppedError
    })
)
