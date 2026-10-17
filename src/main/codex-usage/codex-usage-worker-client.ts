import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { UsageScanOptions, UsageScanWorktreeRef } from '../usage/usage-provider-contract'
import { UsageScanStoppedError } from '../usage/usage-scan-stopped-error'
import type { CodexUsagePersistedFile } from './types'
import type { scanCodexUsageFiles } from './scanner'
import type { CodexUsageWorkerMessage, CodexUsageWorkerRequest } from './codex-usage-worker-protocol'

export function scanCodexUsageFilesInWorker(
  worktrees: UsageScanWorktreeRef[],
  previous: CodexUsagePersistedFile[],
  options: UsageScanOptions<CodexUsagePersistedFile> = {}
): ReturnType<typeof scanCodexUsageFiles> {
  if (options.shouldStop?.()) {
    return Promise.reject(new UsageScanStoppedError('Codex usage scan stopped'))
  }
  return new Promise((resolve, reject) => {
    // Same adjacent bundled-entry pattern as the AI Vault scanner.
    const worker = new Worker(join(__dirname, 'codex-usage-worker-entry.js'), {
      workerData: {
        worktrees,
        previous,
        worktreeSetChanged: options.worktreeSetChanged,
        checkpointState: options.onSerializedCheckpoint ? options.checkpointState : undefined
      } satisfies CodexUsageWorkerRequest
    })
    let settled = false
    const finish = (outcome: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      clearInterval(stopTimer)
      worker.removeAllListeners()
      worker.on('error', () => {})
      void worker.terminate().catch(() => {})
      outcome()
    }
    const stop = (): boolean => {
      if (!options.shouldStop?.()) {
        return false
      }
      finish(() => reject(new UsageScanStoppedError('Codex usage scan stopped')))
      return true
    }
    // Termination also interrupts directory discovery and a single very large rollout.
    const stopTimer = setInterval(stop, 100)
    stopTimer.unref()
    worker.on('message', (message: CodexUsageWorkerMessage) => {
      if (settled || stop()) {
        return
      }
      if (message.type === 'result') {
        finish(() => resolve(message.result))
      } else if (message.type === 'error') {
        finish(() =>
          reject(
            message.stopped
              ? new UsageScanStoppedError(message.message)
              : new Error(message.message)
          )
        )
      } else {
        void Promise.resolve()
          .then(() => {
            if (settled || stop()) {
              return
            }
            return message.type === 'checkpoint'
              ? options.onSerializedCheckpoint?.(message.snapshot)
              : options.onCheckpoint?.(message.sources)
          })
          .catch(() => {})
          .then(() => {
            if (!settled) {
              worker.postMessage({ type: 'checkpoint-written' })
            }
          })
      }
    })
    worker.once('error', (error) => {
      if (!stop()) {
        finish(() => reject(error))
      }
    })
    worker.once('exit', (code) => {
      if (!stop()) {
        finish(() =>
          reject(new Error(`Codex usage worker exited before returning a result (${code})`))
        )
      }
    })
  })
}
