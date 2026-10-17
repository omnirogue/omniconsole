import { handoffApi } from '@/components/handoffs/handoff-client'
import { isRejectedHandoff } from '@/components/handoffs/handoff-request-memory'
import { getConnectionIdForFile } from '@/lib/connection-context'
import { workflowData } from '@/lib/console-workflow-client'
import {
  FollowUpException,
  type FollowUpHostIo,
  type FollowUpHubIo
} from '@/lib/session-follow-up-delivery'
import { useAppStore } from '@/store'
import { parseExecutionHostId } from '../../../shared/execution-host'
import type { SessionChain } from '../../../shared/session-chain-types'

/**
 * The real reads and requests behind a saved follow-up. Files are read on the
 * computer that owns them (SSH through its provider), and every request goes through
 * the existing task-file handoff client under the signed-in person.
 */
type ChainHost = Pick<SessionChain, 'hostId' | 'worktreeId'>

function sshTarget(chain: Pick<SessionChain, 'hostId'>): string | null {
  const parsed = parseExecutionHostId(chain.hostId)
  return parsed?.kind === 'ssh' ? parsed.targetId : null
}

export function followUpHostLabel(chain: Pick<SessionChain, 'hostId'>): string {
  const target = sshTarget(chain)
  return target ? (useAppStore.getState().sshTargetLabels.get(target) ?? target) : ''
}

/** True only for an SSH host this app can see is not connected; contact loss proves nothing more. */
export function isFollowUpHostOffline(chain: Pick<SessionChain, 'hostId'>): boolean {
  const target = sshTarget(chain)
  return !!target && useAppStore.getState().sshConnectionStates.get(target)?.status !== 'connected'
}

/** Resolves once the chain's SSH host is connected again, or when aborted. */
export function waitForFollowUpHost(
  chain: Pick<SessionChain, 'hostId'>,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted || !isFollowUpHostOffline(chain)) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | null = null
    const finish = (): void => {
      unsubscribe?.()
      signal.removeEventListener('abort', finish)
      resolve()
    }
    signal.addEventListener('abort', finish)
    unsubscribe = useAppStore.subscribe(() => {
      if (!isFollowUpHostOffline(chain)) {
        finish()
      }
    })
  })
}

/** Resolves after `delayMs`, as soon as the chain's SSH connection state changes, or on abort. */
export function waitForFollowUpRecheck(
  chain: Pick<SessionChain, 'hostId'>,
  signal: AbortSignal,
  delayMs: number
): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve()
  }
  const target = sshTarget(chain)
  const status = (): string | undefined =>
    target ? useAppStore.getState().sshConnectionStates.get(target)?.status : undefined
  const initial = status()
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | null = null
    const finish = (): void => {
      clearTimeout(timer)
      unsubscribe?.()
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, delayMs)
    signal.addEventListener('abort', finish)
    if (target) {
      unsubscribe = useAppStore.subscribe(() => {
        if (status() !== initial) {
          finish()
        }
      })
    }
  })
}

function connection(chain: ChainHost, path: string): { connectionId?: string } {
  const connectionId = getConnectionIdForFile(chain.worktreeId, path)
  // Why: an owner that has not hydrated must never fall back to a local read of a remote path.
  if (connectionId === undefined) {
    throw new FollowUpException('host-unreachable', followUpHostLabel(chain))
  }
  return connectionId ? { connectionId } : {}
}

export function createFollowUpHostIo(chain: ChainHost): FollowUpHostIo {
  return {
    exists: (path) => window.api.fs.pathExists({ filePath: path, ...connection(chain, path) }),
    size: async (path) =>
      (await window.api.fs.stat({ filePath: path, ...connection(chain, path) })).size,
    readExact: async (path) =>
      workflowData(
        await handoffApi().readAttachment({
          filePath: path,
          threadUpload: true,
          ...connection(chain, path)
        })
      )
  }
}

export function createFollowUpHubIo(): FollowUpHubIo {
  return {
    get: async (input) => workflowData(await handoffApi().get(input)),
    respond: async (input) => workflowData(await handoffApi().respond(input)),
    returnFile: async (input) => workflowData(await handoffApi().returnFile(input)),
    agentRecipients: async () => workflowData(await handoffApi().agentRecipients()),
    sendAgent: async (input) => workflowData(await handoffApi().sendAgent(input)),
    upload: async (taskId, file) => workflowData(await handoffApi().uploadFile({ taskId, file })),
    send: async (input) => workflowData(await handoffApi().send(input)),
    sendCardless: async (input) => workflowData(await handoffApi().sendCardless(input)),
    uploadThreadFile: async (input) => workflowData(await handoffApi().uploadThreadFile(input)),
    isRejected: isRejectedHandoff
  }
}
