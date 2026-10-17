import type { LocalRunSnapshot } from '../../../shared/local-run-types'
import type { OrcaRuntimeService } from '../omni-runtime'
import { warnStaleDispatches } from '../orchestration/coordinator-task-dispatch'
import { getRuntimeDesktopSurface } from '../runtime-desktop-surface'
import { pushLocalRunEvent } from './local-run-state'

/** How often silent workers are looked for while the pool waits on them. */
const STALE_SCAN_MS = 30_000

export type LocalRunStaleWatch = { scan: () => void; stop: () => void }

/**
 * A silent worker keeps its slot and is never failed. Each silence is said once: on the
 * card as an error event naming the node, and as a desktop notification.
 */
export function startLocalRunStaleWatch(
  deps: { runtime: OrcaRuntimeService; changed: (snapshot: LocalRunSnapshot) => void },
  snapshot: LocalRunSnapshot
): LocalRunStaleWatch {
  const scan = (): void => {
    if (!snapshot.runId) {
      return
    }
    warnStaleDispatches(deps.runtime.getOrchestrationDb(), () => {}, {
      runId: snapshot.runId,
      onAttention: (attention) => {
        const node = snapshot.nodes.find((entry) => entry.taskId === attention.taskId)
        pushLocalRunEvent(snapshot, 'error', node?.id ?? 'run', attention.message)
        getRuntimeDesktopSurface().showNotification({
          title: 'An agent may be stuck',
          body: attention.message
        })
        deps.changed(snapshot)
      }
    })
  }
  const timer = setInterval(() => {
    try {
      scan()
    } catch {
      // A missed scan is retried on the next interval.
    }
  }, STALE_SCAN_MS).unref()
  return { scan, stop: () => clearInterval(timer) }
}

function notStartedNodeIds(snapshot: LocalRunSnapshot): string[] {
  return snapshot.nodes
    .filter((node) => node.state === 'queued' || node.state === 'waiting')
    .map((node) => node.id)
}

/** Appended to a failed run's error so the nodes a failure stranded are named too. */
export function localRunStrandedSuffix(snapshot: LocalRunSnapshot): string {
  const stranded = notStartedNodeIds(snapshot)
  return stranded.length > 0
    ? `. Not started because a dependency failed: ${stranded.join(', ')}`
    : ''
}

export function localRunStuckMessage(snapshot: LocalRunSnapshot): string {
  const stranded = notStartedNodeIds(snapshot)
  return stranded.length > 0
    ? `The run cannot continue: ${stranded.join(', ')} depend on work that failed.`
    : 'The run cannot continue and no node is runnable.'
}
