import type { z } from 'zod'
import type { SessionPrepConnectorLaunch } from '../../shared/session-prep-connector'
import type { SESSION_PREP_PARAMS } from '../../shared/session-prep-types'
import { isTuiAgent } from '../../shared/tui-agent-config'
import { WorkflowScriptSlots } from '../runtime/workflow-script/workflow-script-slots'
import { assertSessionPrepExecutionHost } from './session-prep-execution-host'
import type { SessionPrepHost } from './session-prep-host'
import type { SessionPrepBatchRecord } from './session-prep-records'
import type { SessionPrepStore } from './session-prep-store'
import { consumeConnectorNonce } from './session-prep-connector-nonce'

export type ConnectorRegistration = {
  operator: string
  digest: string
  launch: SessionPrepConnectorLaunch
  nonce: string
  expiresAt: number
  statusOnly: boolean
}

export type RequestParams = z.infer<typeof SESSION_PREP_PARAMS.request>

/** `started` only once the batch is saved and scheduled; `not-started` says why. */
export type SessionPrepCheckedRequest =
  | { outcome: 'started'; batchId: string; startedIn?: string }
  | { outcome: 'already-requested'; batchId: string }
  | { outcome: 'not-started'; batchId: string; reason: string }

type SourceCheck = { worktreeId: string; fallbackPath?: string } | { reason: string }
type SourceHost = Pick<SessionPrepHost, 'resolveWorktree' | 'defaultSourceWorktreeId'>

// Why: the same words resubmitted from the same pane soon after are a repeat, not new work.
const RESUBMIT_WINDOW_MS = 2 * 60_000

/** Keeps acceptance durable before launching, including retries after a lost RPC response. */
export class SessionPrepRequests {
  private readonly acceptance = new WorkflowScriptSlots(1)

  constructor(
    private readonly store: SessionPrepStore,
    private readonly now: () => number,
    private readonly newId: () => string,
    private readonly schedule: (batchId: string) => void
  ) {}

  request(params: RequestParams): { batchId: string } {
    if (params.requestId) {
      throw new Error('A request identity requires durable acceptance.')
    }
    const batch = this.create(params)
    this.store.upsert(batch)
    void this.store.persist()
    this.schedule(batch.id)
    return { batchId: batch.id }
  }

  requestDurable(
    params: RequestParams,
    connector?: ConnectorRegistration
  ): Promise<{ batchId: string }> {
    return this.acceptance.run(async () => {
      if (!params.requestId) {
        throw new Error('A request identity is required.')
      }
      await this.store.load()
      let batch = this.store.list().find((entry) => entry.requestId === params.requestId)
      if (batch && (!sameRequest(batch, params) || batch.connectorDigest !== connector?.digest)) {
        throw new Error('This request identity was already used for different work.')
      }
      if (connector) {
        if (connector.expiresAt * 1000 <= this.now()) {
          throw new Error('Connector session prep assertion expired.')
        }
        if (connector.statusOnly) {
          if (!batch) {
            throw new Error('Connector operation has not been accepted.')
          }
          return { batchId: batch.id }
        }
        await consumeConnectorNonce(
          this.store.directory,
          connector.nonce,
          connector.expiresAt,
          this.now()
        )
        if (batch) {
          throw new Error('Connector operation was already accepted; request status instead.')
        }
      }
      if (!batch) {
        batch = this.create(params)
        if (connector) {
          batch.connectorLaunch = connector.launch
          batch.connectorOperator = connector.operator
          batch.connectorDigest = connector.digest
        }
        this.store.upsert(batch)
      }
      // A failed write leaves an unscheduled record; retry the same write before accepting it.
      await this.store.persist()
      if (batch.state === 'planning') {
        this.schedule(batch.id)
      }
      return { batchId: batch.id }
    })
  }

  /**
   * Starts a request only from a workspace that resolves (its own, else the host's default) and
   * after it is saved. A repeat within the window reuses its batch; a failed one is retried in it.
   */
  requestChecked(params: RequestParams, host: SourceHost): Promise<SessionPrepCheckedRequest> {
    return this.acceptance.run(async () => {
      const repeat = this.recentRepeat(params)
      if (repeat && repeat.state !== 'failed') {
        return { outcome: 'already-requested', batchId: repeat.id }
      }
      const batch = repeat ?? this.create(params)
      const checked = await checkSessionPrepSource(host, params.source.worktreeId)
      batch.updatedAt = this.now()
      batch.source = { ...batch.source, worktreeId: params.source.worktreeId }
      if ('reason' in checked) {
        batch.state = 'failed'
        batch.dropped = [checked.reason]
      } else {
        batch.state = 'planning'
        batch.source.worktreeId = checked.worktreeId
        batch.dropped = checked.fallbackPath
          ? [`Started from ${checked.fallbackPath}: the terminal's workspace was not available.`]
          : []
      }
      this.store.upsert(batch)
      try {
        await this.store.persist()
      } catch (error) {
        batch.state = 'failed'
        batch.dropped = [`The request could not be saved: ${errorText(error)}`]
        return { outcome: 'not-started', batchId: batch.id, reason: batch.dropped[0]! }
      }
      if ('reason' in checked) {
        return { outcome: 'not-started', batchId: batch.id, reason: checked.reason }
      }
      this.schedule(batch.id)
      return {
        outcome: 'started',
        batchId: batch.id,
        ...(checked.fallbackPath ? { startedIn: checked.fallbackPath } : {})
      }
    })
  }

  private recentRepeat(params: RequestParams): SessionPrepBatchRecord | null {
    const since = this.now() - RESUBMIT_WINDOW_MS
    return (
      this.store
        .list()
        .filter(
          (batch) =>
            batch.source.paneKey === params.source.paneKey &&
            batch.request === params.text &&
            batch.createdAt >= since &&
            batch.state !== 'cancelled' &&
            // A failed batch is retried in place only if nothing in it ever started.
            (batch.state !== 'failed' || batch.items.length === 0)
        )
        .sort((left, right) => right.createdAt - left.createdAt)[0] ?? null
    )
  }

  private create(params: RequestParams): SessionPrepBatchRecord {
    if (!isTuiAgent(params.source.agent)) {
      throw new Error('That agent cannot start session prep.')
    }
    const now = this.now()
    return {
      id: this.newId(),
      ...(params.requestId ? { requestId: params.requestId } : {}),
      createdAt: now,
      updatedAt: now,
      state: 'planning',
      source: { ...params.source, agent: params.source.agent },
      request: params.text,
      context: params.context,
      ...(params.agentTemplateId ? { agentTemplateId: params.agentTemplateId } : {}),
      ...(params.defaultFolder ? { defaultFolder: params.defaultFolder } : {}),
      dropped: [],
      items: []
    }
  }
}

function sameRequest(batch: SessionPrepBatchRecord, params: RequestParams): boolean {
  const sourceKey = (source: RequestParams['source']) =>
    JSON.stringify(Object.entries(source).sort(([left], [right]) => left.localeCompare(right)))
  return (
    batch.request === params.text &&
    batch.context === params.context &&
    batch.agentTemplateId === params.agentTemplateId &&
    batch.defaultFolder === params.defaultFolder &&
    sourceKey(batch.source) === sourceKey(params.source)
  )
}

async function checkSessionPrepSource(host: SourceHost, worktreeId: string): Promise<SourceCheck> {
  let chosen = worktreeId
  let fallbackPath: string | undefined
  let workspace
  try {
    workspace = await host.resolveWorktree(worktreeId)
  } catch (error) {
    // Why only an unknown workspace falls back: a refused SSH or paired host must not go local.
    const fallback = host.defaultSourceWorktreeId?.()
    workspace =
      fallback && fallback !== worktreeId
        ? await host.resolveWorktree(fallback).catch(() => null)
        : null
    if (!workspace || !fallback) {
      return {
        reason: `${errorText(error)} No default Work folder is registered to start from instead.`
      }
    }
    chosen = fallback
    fallbackPath = workspace.path
  }
  try {
    assertSessionPrepExecutionHost(workspace)
  } catch (error) {
    return { reason: errorText(error) }
  }
  return { worktreeId: chosen, ...(fallbackPath ? { fallbackPath } : {}) }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
