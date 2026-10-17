import {
  OMP_ROUTE_RELAY_CAPABILITY,
  OMP_ROUTE_RELAY_DISCOVER,
  OMP_ROUTE_RELAY_PREPARE,
  OMP_ROUTE_RELAY_UNAVAILABLE,
  type OmpRelayRouteRequest,
  type OmpRelayRoutePrepared
} from '../../shared/omp-route-relay'
import type { DiscoverCommitMessageModelsResult } from '../text-generation/source-control-text-generation-types'
import { isJsonRpcMethodNotFoundError } from './ssh-git-relay-errors'
import type { CommitMessagePlan } from '../../shared/commit-message-plan'
import type { RemoteCommitMessageExecResult } from '../text-generation/commit-message-text-generation'
import { SshGitReadProvider } from './ssh-git-read-provider'
import {
  SESSION_PREP_ACCOUNT_METHOD,
  sessionPrepAccountResult,
  type SessionPrepAccount
} from '../../shared/session-prep-account'

type NonInteractiveExecQueueEntry = {
  started: boolean
  canceled: boolean
  done: Promise<void>
  release: () => void
}

const NON_INTERACTIVE_TRANSPORT_TIMEOUT_MARGIN_MS = 5_000

export class SshGitNoninteractiveProvider extends SshGitReadProvider {
  async prepareSessionAccount(
    provider: 'claude' | 'codex',
    model?: string
  ): Promise<SessionPrepAccount> {
    const startedAt = performance.now()
    const result = sessionPrepAccountResult.parse(
      await this.mux.request(
        SESSION_PREP_ACCOUNT_METHOD,
        { provider, ...(model ? { model } : {}) },
        { timeoutMs: 180_000 }
      )
    )
    if (
      result.provider !== provider ||
      result.ageAtReplyMs + Math.max(0, performance.now() - startedAt - result.processingMs) >
        60_000
    ) {
      throw new Error('SSH account capacity is stale or belongs to another provider.')
    }
    return result
  }
  private async requestOmpRoute(method: string, params: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.mux.request(method, params, { timeoutMs: 70_000 })
    } catch (error) {
      if (isJsonRpcMethodNotFoundError(error)) {
        throw new Error(OMP_ROUTE_RELAY_UNAVAILABLE)
      }
      throw error
    }
  }

  async discoverOmpRoutes(): Promise<DiscoverCommitMessageModelsResult> {
    const result = (await this.requestOmpRoute(OMP_ROUTE_RELAY_DISCOVER, {})) as {
      capability?: string
      catalog: DiscoverCommitMessageModelsResult
    }
    if (result?.capability !== OMP_ROUTE_RELAY_CAPABILITY || !result.catalog) {
      throw new Error(OMP_ROUTE_RELAY_UNAVAILABLE)
    }
    return result.catalog
  }

  async prepareOmpRoute(request: OmpRelayRouteRequest): Promise<string> {
    const result = (await this.requestOmpRoute(
      OMP_ROUTE_RELAY_PREPARE,
      request
    )) as OmpRelayRoutePrepared
    if (result?.capability !== OMP_ROUTE_RELAY_CAPABILITY || typeof result.agentArgs !== 'string') {
      throw new Error(OMP_ROUTE_RELAY_UNAVAILABLE)
    }
    return result.agentArgs
  }

  private readonly nonInteractiveExecQueues = new Map<string, NonInteractiveExecQueueEntry[]>()

  async executeCommitMessagePlan(
    plan: CommitMessagePlan,
    cwd: string,
    timeoutMs: number,
    operation = 'commit-message',
    env?: Record<string, string>,
    signal?: AbortSignal
  ): Promise<RemoteCommitMessageExecResult> {
    return this.runQueuedNonInteractiveExec(
      cwd,
      {
        binary: plan.binary,
        args: plan.args,
        cwd,
        stdin: plan.stdinPayload,
        timeoutMs,
        operation,
        ...(env ? { env } : {})
      },
      signal,
      operation
    )
  }

  async execNonInteractive(
    binary: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
    signal?: AbortSignal,
    env?: Record<string, string>
  ): Promise<RemoteCommitMessageExecResult> {
    return this.runQueuedNonInteractiveExec(
      cwd,
      {
        binary,
        args,
        cwd,
        stdin: null,
        timeoutMs,
        ...(env ? { env } : {})
      },
      signal
    )
  }

  async cancelNonInteractiveExec(cwd: string, operation?: string): Promise<void> {
    const queue = this.nonInteractiveExecQueues.get(this.nonInteractiveLaneKey(cwd, operation))
    const queuedEntry = queue?.find((entry) => !entry.started && !entry.canceled)
    if (queuedEntry) {
      queuedEntry.canceled = true
      return
    }
    await this.cancelActiveNonInteractiveExec(cwd, operation)
  }

  async cancelGenerateCommitMessage(
    worktreePath: string,
    operation = 'commit-message'
  ): Promise<void> {
    await this.cancelNonInteractiveExec(worktreePath, operation)
  }

  private async cancelActiveNonInteractiveExec(cwd: string, operation?: string): Promise<void> {
    try {
      await this.mux.request('agent.cancelExec', {
        cwd,
        ...(operation ? { operation } : {})
      })
    } catch {
      // Best-effort: callers are already unwinding after cancellation.
    }
  }

  private nonInteractiveLaneKey(cwd: string, operation?: string): string {
    return JSON.stringify([operation || 'default', cwd])
  }

  private async runQueuedNonInteractiveExec(
    cwd: string,
    payload: {
      binary: string
      args: string[]
      cwd: string
      stdin: string | null
      timeoutMs: number
      env?: Record<string, string>
      operation?: string
    },
    signal?: AbortSignal,
    operation?: string
  ): Promise<RemoteCommitMessageExecResult> {
    const laneKey = this.nonInteractiveLaneKey(cwd, operation)
    const queue = this.nonInteractiveExecQueues.get(laneKey) ?? []
    const previous = queue.at(-1)?.done ?? Promise.resolve()
    let releaseEntry!: () => void
    const entry: NonInteractiveExecQueueEntry = {
      started: false,
      canceled: false,
      done: previous
        .catch(() => {})
        .then(
          () =>
            new Promise<void>((resolve) => {
              releaseEntry = resolve
            })
        ),
      release: () => releaseEntry()
    }
    queue.push(entry)
    this.nonInteractiveExecQueues.set(laneKey, queue)
    const abortEntry = (): void => {
      if (!entry.started) {
        entry.canceled = true
        return
      }
      void this.cancelActiveNonInteractiveExec(cwd, operation)
    }
    if (signal?.aborted) {
      entry.canceled = true
    } else {
      signal?.addEventListener('abort', abortEntry, { once: true })
    }

    await previous.catch(() => {})
    try {
      if (entry.canceled) {
        return {
          stdout: '',
          stderr: '',
          exitCode: null,
          timedOut: false,
          canceled: true
        }
      }
      entry.started = true
      return (await this.mux.request('agent.execNonInteractive', payload, {
        timeoutMs: payload.timeoutMs + NON_INTERACTIVE_TRANSPORT_TIMEOUT_MARGIN_MS
      })) as RemoteCommitMessageExecResult
    } finally {
      signal?.removeEventListener('abort', abortEntry)
      entry.release()
      const currentQueue = this.nonInteractiveExecQueues.get(laneKey)
      const entryIndex = currentQueue?.indexOf(entry) ?? -1
      if (entryIndex >= 0) {
        currentQueue?.splice(entryIndex, 1)
      }
      if (currentQueue?.length === 0) {
        this.nonInteractiveExecQueues.delete(laneKey)
      }
    }
  }
}
