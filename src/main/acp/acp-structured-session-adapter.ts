import { AgentSessionAcquisitionExitUnprovenError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { acquireAcpSession } from './acp-session-acquisition'
import { randomUUID } from 'node:crypto'
import { parseAgentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { acpSpawnRecipe, isAcpStructuredAgent } from '../../shared/acp-agent-recipes'
import type {
  AgentSessionAcquisition,
  StructuredAgentSessionAcquireInput,
  StructuredAgentSessionAdapter
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import { AgentSessionPromptGoneError } from '../native-chat/agent-session-wire/structured-agent-session-prompt-error'
import { supportsCodexStructuredLocation } from '../codex/codex-structured-location-support'
import {
  openAcpJsonRpcConnection,
  AcpChildExitUnprovenError,
  type AcpJsonRpcConnection,
  type AcpJsonRpcLaunch
} from './acp-jsonrpc-connection'
import { applyAcpSessionOption } from './acp-session-config'
import { acpPromptBlocks, acpPromptReply } from './acp-session-events'

export type AcpStructuredSessionAdapterDeps = {
  openConnection?: typeof openAcpJsonRpcConnection
  resolveLaunch: (input: {
    identity: StructuredAgentSessionAcquireInput['identity']
    spawnToken: string
  }) => Promise<AcpJsonRpcLaunch>
  readProcessStartTime: (pid: number) => Promise<number | null>
  now?: () => number
  enabled?: (agent: string) => boolean
}

import { publishAcpTurn, type AcpSession } from './acp-session-notifications'

export class AcpStructuredSessionAdapter implements StructuredAgentSessionAdapter {
  private readonly pendingCleanup = new Map<string, () => Promise<boolean>>()
  private readonly sessions = new Map<string, AcpSession>()
  private readonly connections = new Map<string, AcpJsonRpcConnection>()
  private readonly openConnection: typeof openAcpJsonRpcConnection

  constructor(private readonly deps: AcpStructuredSessionAdapterDeps) {
    this.openConnection = deps.openConnection ?? openAcpJsonRpcConnection
  }

  supportsCreate: NonNullable<StructuredAgentSessionAdapter['supportsCreate']> = (
    location,
    agent
  ) =>
    isAcpStructuredAgent(agent) &&
    Boolean(acpSpawnRecipe(agent)) &&
    process.platform !== 'win32' &&
    supportsCodexStructuredLocation(location)

  supportsLocation = (location: Parameters<typeof supportsCodexStructuredLocation>[0]): boolean =>
    process.platform !== 'win32' && supportsCodexStructuredLocation(location)

  acquire = async (input: StructuredAgentSessionAcquireInput): Promise<AgentSessionAcquisition> => {
    try {
      return await acquireAcpSession(
        {
          deps: this.deps,
          sessions: this.sessions,
          connections: this.connections,
          openConnection: this.openConnection,
          setOption: this.setOption
        },
        input
      )
    } catch (error) {
      if (error instanceof AcpChildExitUnprovenError) {
        this.pendingCleanup.set(input.identity.sessionId, error.retryClose)
      }
      const stopped = await this.closeSession(input.identity.sessionId)
      if (!stopped) {
        throw new AgentSessionAcquisitionExitUnprovenError(error)
      }
      throw error
    }
  }

  dispatch: StructuredAgentSessionAdapter['dispatch'] = async (input) => {
    const session = this.sessions.get(input.sessionId)
    if (
      !session ||
      session.fence !== input.fence ||
      session.connection.closed ||
      session.activeTurnId
    ) {
      return { state: 'rejected', reason: 'ACP session is not live' }
    }
    const prompt = await acpPromptBlocks(input.body, session.imageCapable)
    if (!prompt.ok) {
      return { state: 'rejected', reason: prompt.reason }
    }
    session.promptCount += 1
    session.sourceOptions = {
      clientMessageId: input.clientMessageId,
      model: session.config.values.get(session.config.modelId ?? 'model'),
      effort: session.config.values.get(session.config.effortId ?? 'effort')
    }
    session.assistant.text = ''
    const turnId = `acp-turn-${randomUUID()}`
    session.activeTurnId = turnId
    session.cancelRequestedTurnId = undefined
    let accept = (): void => undefined
    const accepted = new Promise<void>((resolve) => {
      accept = resolve
    })
    session.acceptTurn = accept
    publishAcpTurn(session, turnId, 'running')
    const completion = session.connection
      .request(
        'session/prompt',
        {
          sessionId: session.acpSessionId,
          prompt: prompt.prompt
        },
        { timeoutMs: 0 }
      )
      .then(
        (response: unknown) => {
          if (session.activeTurnId === turnId) {
            session.activeTurnId = null
          }
          // A resolved prompt is not by itself a finished turn (#283): only an explicit
          // `end_turn` counts as completion, a cancel is an interrupt (#289's distinction),
          // and any other stop reason stays `unknown` so no consumer reads it as success.
          const stopReason =
            response && typeof response === 'object' && 'stopReason' in response
              ? response.stopReason
              : undefined
          publishAcpTurn(
            session,
            turnId,
            'completed',
            session.cancelRequestedTurnId === turnId || stopReason === 'cancelled'
              ? 'interrupted'
              : stopReason === 'end_turn'
                ? 'completed'
                : 'unknown'
          )
        },
        (error: unknown) => {
          if (session.activeTurnId === turnId) {
            session.activeTurnId = null
          }
          publishAcpTurn(session, turnId, 'completed', 'failed')
          throw error
        }
      )
      .finally(() => {
        if (session.activeTurnId === turnId) {
          session.activeTurnId = null
        }
        session.acceptTurn = undefined
      })
    // A streamed update proves receipt and frees the host mutation queue for ask-card replies.
    void completion.catch(() => undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        accepted,
        completion,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('ACP prompt receipt is unconfirmed')), 20_000)
        })
      ])
    } catch (error) {
      return { state: 'unknown', reason: error instanceof Error ? error.message : String(error) }
    } finally {
      if (timer) {
        clearTimeout(timer)
      }
    }
    return {
      state: 'accepted',
      providerIdentity: {
        provider: 'legacy',
        agent: session.agent,
        sessionId: session.acpSessionId,
        recordId: `${turnId}:user`
      }
    }
  }

  cancelTurn: StructuredAgentSessionAdapter['cancelTurn'] = async (input) => {
    const session = this.sessions.get(input.sessionId)
    if (!session || session.fence !== input.fence || session.activeTurnId !== input.turnId) {
      return { cancelled: false }
    }
    session.cancelRequestedTurnId = input.turnId
    session.connection.notify('session/cancel', { sessionId: session.acpSessionId })
    return { cancelled: true }
  }

  answerPrompt: StructuredAgentSessionAdapter['answerPrompt'] = async (input) => {
    const session = this.sessions.get(input.sessionId)
    const identity = parseAgentJournalItemKey(input.itemId)
    const pendingKey = identity?.provider === 'legacy' ? identity.recordId : input.itemId
    const pending = session?.pendingPermissions.get(pendingKey)
    if (!session || session.fence !== input.fence || !pending) {
      throw new AgentSessionPromptGoneError('ACP permission request is no longer pending')
    }
    if (pending.optionIds && !pending.optionIds.includes(input.optionId)) {
      throw new Error('ACP permission request does not offer that option')
    }
    session.pendingPermissions.delete(pendingKey)
    session.connection.respond(pending.id, acpPromptReply(pending, pendingKey, input.optionId))
  }

  setOption: StructuredAgentSessionAdapter['setOption'] = async (input) => {
    const session = this.sessions.get(input.sessionId)
    if (!session || session.fence !== input.fence || session.activeTurnId) {
      throw new AgentSessionOptionRejectedError('ACP session is unavailable or working')
    }
    if (
      session.agent === 'omp' &&
      session.options.openrouterCandidates !== undefined &&
      input.key === 'model' &&
      input.value !== session.options.model
    ) {
      throw new AgentSessionOptionRejectedError(
        'Start a new session to change the model of a saved OpenRouter route.'
      )
    }
    try {
      session.config = await applyAcpSessionOption({
        connection: session.connection,
        acpSessionId: session.acpSessionId,
        config: session.config,
        key: input.key,
        value: input.value
      })
    } catch (error) {
      throw new AgentSessionOptionRejectedError(error)
    }
    return { ...session.options, ...session.config.result.current }
  }

  readOptions = async (input: { sessionId: string; fence: number }) =>
    this.sessions.get(input.sessionId)?.config.result ?? { models: [], current: { model: '' } }

  readSourceOptions: NonNullable<StructuredAgentSessionAdapter['readSourceOptions']> = async (
    input
  ) => {
    const session = this.sessions.get(input.sessionId)
    return session?.fence === input.fence &&
      session.sourceOptions?.clientMessageId === input.clientMessageId
      ? { model: session.sourceOptions.model, effort: session.sourceOptions.effort }
      : null
  }

  closeSession = async (sessionId: string): Promise<boolean> => {
    const cleanup = this.pendingCleanup.get(sessionId)
    if (cleanup && !(await cleanup())) {
      return false
    }
    this.pendingCleanup.delete(sessionId)
    const connection = this.connections.get(sessionId)
    const stopped = connection ? await connection.close() : true
    if (stopped && this.connections.get(sessionId) === connection) {
      this.connections.delete(sessionId)
      this.sessions.delete(sessionId)
    }
    return stopped
  }

  disposeSession = (sessionId: string): Promise<boolean> => this.closeSession(sessionId)
  forceCloseSession = (sessionId: string): Promise<boolean> => this.closeSession(sessionId)
  releaseAcquisition = (input: { sessionId: string }): Promise<boolean> =>
    this.closeSession(input.sessionId)
  closeAll = async (): Promise<void> => {
    const stopped = await Promise.all(
      [...new Set([...this.connections.keys(), ...this.pendingCleanup.keys()])].map((id) =>
        this.closeSession(id)
      )
    )
    if (stopped.some((value) => !value)) {
      throw new Error('ACP child exit remains unproven')
    }
  }
}
