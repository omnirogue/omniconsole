import { isAcpStructuredAgent } from '../../../shared/acp-agent-recipes'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'

type ManagedAdapter = StructuredAgentSessionAdapter & { closeAll(): Promise<void> }

/**
 * Three structured lanes, one router.
 *
 * Codex keeps the app-server lane. Claude now has two: the Claude Agent SDK
 * adapter (upstream #18560) and the pre-existing ACP adapter. Precedence is
 * settled here rather than at the call site so a record recovered after restart
 * routes the same way the launch did:
 *
 *  1. an explicit `transport: 'acp'` always wins — it is a deliberate request;
 *  2. a Claude launch routes to the SDK adapter when one is installed and the
 *     person has not opted Claude into ACP;
 *  3. everything else keeps the behaviour it had before the SDK lane existed.
 *
 * `claude` is optional: a build without the agent SDK, an unsupported platform,
 * or a refused credential leaves it absent, and Claude falls back to the lane it
 * used before rather than failing the launch.
 */
export class StructuredAgentSessionAdapterRouter implements StructuredAgentSessionAdapter {
  private readonly owners = new Map<string, ManagedAdapter>()

  constructor(
    private readonly deps: {
      codex: ManagedAdapter
      acp: ManagedAdapter
      /** Absent when the Claude Agent SDK lane is unavailable on this host. */
      claude?: ManagedAdapter & { drainObservedExits?: () => Promise<void> }
      /** Required whenever `claude` is supplied: registering the lane and deciding
       *  when it is live are separate answers, and a lane with no gate is a lane
       *  that ignores the experimental setting. */
      claudeEnabled?: () => boolean
      record: (sessionId: string) => AgentSessionRecord | null
      acpEnabled: (agent: string) => boolean
    }
  ) {}

  /** Resolves once every first-hand provider exit observed so far has published
   *  its lifecycle event. Only the Claude SDK lane trails observation this way:
   *  its close ladder and transcript write land after the child dies, so an
   *  observed death is not yet a chained one. Codex publishes inside its own
   *  exit callback and needs nothing, and the router owns the fan-out because
   *  the runtime only holds the router, never the individual lanes. */
  drainObservedExits = async (): Promise<void> => {
    await this.deps.claude?.drainObservedExits?.()
  }

  /** The SDK lane, or null when it is unavailable or the person chose ACP for Claude. */
  private claudeSdk(): ManagedAdapter | null {
    if (!this.deps.claude || this.deps.claudeEnabled?.() !== true) {
      return null
    }
    return this.deps.acpEnabled('claude') ? null : this.deps.claude
  }

  supportsCreate: NonNullable<StructuredAgentSessionAdapter['supportsCreate']> = (
    location,
    agent
  ) => {
    if (agent === 'codex') {
      return this.deps.codex.supportsLocation?.(location) ?? false
    }
    const claude = agent === 'claude' ? this.claudeSdk() : null
    if (claude) {
      return claude.supportsLocation?.(location) ?? false
    }
    return (
      isAcpStructuredAgent(agent) &&
      this.deps.acpEnabled(agent) &&
      (this.deps.acp.supportsCreate?.(location, agent) ?? false)
    )
  }

  acquire: StructuredAgentSessionAdapter['acquire'] = async (input) => {
    const adapter = this.adapterFor(input.identity.agent, input.options?.transport)
    this.owners.set(input.identity.sessionId, adapter)
    return adapter.acquire(input)
  }

  private adapterFor(agent: string, transport: string | undefined): ManagedAdapter {
    if (transport === 'acp') {
      return this.deps.acp
    }
    if (agent === 'codex') {
      return this.deps.codex
    }
    return (agent === 'claude' ? this.claudeSdk() : null) ?? this.deps.acp
  }

  private owner(sessionId: string): ManagedAdapter {
    const existing = this.owners.get(sessionId)
    if (existing) {
      return existing
    }
    const record = this.deps.record(sessionId)
    return this.adapterFor(record?.provider ?? '', record?.options?.transport)
  }

  dispatch: StructuredAgentSessionAdapter['dispatch'] = (input) =>
    this.owner(input.sessionId).dispatch(input)

  compact: NonNullable<StructuredAgentSessionAdapter['compact']> = (input) => {
    const compact = this.owner(input.sessionId).compact
    if (!compact) {
      throw new Error('Compaction is unavailable for this provider.')
    }
    return compact(input)
  }

  cancelTurn: StructuredAgentSessionAdapter['cancelTurn'] = (input) =>
    this.owner(input.sessionId).cancelTurn(input)

  stopBackgroundTasks: NonNullable<StructuredAgentSessionAdapter['stopBackgroundTasks']> = (
    input
  ) => {
    const stop = this.owner(input.sessionId).stopBackgroundTasks
    return stop ? stop(input) : Promise.resolve({ cancelled: false })
  }

  backgroundTaskState: NonNullable<StructuredAgentSessionAdapter['backgroundTaskState']> = (
    sessionId
  ) => this.owners.get(sessionId)?.backgroundTaskState?.(sessionId)

  answerPrompt: StructuredAgentSessionAdapter['answerPrompt'] = (input) =>
    this.owner(input.sessionId).answerPrompt(input)
  setOption: StructuredAgentSessionAdapter['setOption'] = (input) =>
    this.owner(input.sessionId).setOption(input)
  readOptions: NonNullable<StructuredAgentSessionAdapter['readOptions']> = (input) =>
    this.owner(input.sessionId).readOptions?.(input) ??
    Promise.resolve({ models: [], current: { model: '' } })
  readSourceOptions: NonNullable<StructuredAgentSessionAdapter['readSourceOptions']> = (input) =>
    this.owner(input.sessionId).readSourceOptions?.(input) ?? Promise.resolve(null)
  historyFilePath: NonNullable<StructuredAgentSessionAdapter['historyFilePath']> = (input) =>
    this.owner(input.identity.sessionId).historyFilePath?.(input) ?? Promise.resolve(null)

  providerHistoryWindow: NonNullable<StructuredAgentSessionAdapter['providerHistoryWindow']> = (
    input
  ) => this.owner(input.identity.sessionId).providerHistoryWindow?.(input) ?? Promise.resolve(null)

  closeSession = async (sessionId: string): Promise<boolean> => {
    const closed = (await this.owner(sessionId).closeSession?.(sessionId)) ?? false
    if (closed) {
      this.owners.delete(sessionId)
    }
    return closed
  }
  disposeSession = (sessionId: string): Promise<boolean> => this.closeSession(sessionId)
  releaseAcquisition = (input: { sessionId: string }): Promise<boolean> =>
    this.closeSession(input.sessionId)
  closeAll = async (): Promise<void> => {
    await Promise.all([
      this.deps.codex.closeAll(),
      this.deps.acp.closeAll(),
      this.deps.claude?.closeAll() ?? Promise.resolve()
    ])
  }
}
