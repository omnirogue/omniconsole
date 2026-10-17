import {
  normalizeAgentProviderSession,
  isResumableTuiAgent,
  getAgentResumeArgv,
  type ResumableTuiAgent
} from '../../../../shared/agent-session-resume'
import type { AgentSessionExecutionClaim } from '../../../../shared/agent-session-host-authority'
import type { IPtyProvider, PtySpawnOptions, PtySpawnResult } from '../../../providers/types'
import { getAppPtyId, getProvider } from '../provider/registry'
import { makePaneSpawnReservationKey, paneSpawnReservationsByOwnerKey } from './spawn-reservation'
import type { PtySpawnIpcArgs } from '../ipc/spawn-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  tokenizeStartupCommand,
  resolveStartupShell
} from '../../../../shared/tui-agent-startup-shell'
import { SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV } from '../../../../shared/setup-agent-sequencing'

export type ProviderConversationRequest = Partial<Omit<PtySpawnIpcArgs, 'launchPriority'>> & {
  isNewSession?: boolean
  agentSessionEnsure?: { claim: AgentSessionExecutionClaim }
}

const owners = new Map<string, Set<ProviderConversationReservation>>()

/** The existing typed refusal: structured ensures see the claim conflict, panes the running marker. */
export function providerConversationConflict(args: ProviderConversationRequest): Error {
  return Object.assign(
    new Error(
      args.agentSessionEnsure ? 'agent_session_conflict' : 'terminal_provider_conversation_running'
    ),
    { code: 'agent_session_conflict' as const }
  )
}

/** The conversation a launch command resumes, or null when it starts fresh or is not tracked. */
export function parseProviderConversation(
  agent: string | undefined,
  command: string | undefined,
  shell: { connectionId?: string | null; shellOverride?: string }
): { agent: ResumableTuiAgent; id: string } | null {
  if (!isResumableTuiAgent(agent) || ['pi', 'prime-agent', 'omp'].includes(agent)) {
    return null
  }
  const argv = getAgentResumeArgv(agent, {
    key: agent === 'antigravity' ? 'conversation_id' : 'session_id',
    id: '_'
  })
  const startupShell = resolveStartupShell(
    shell.connectionId ? 'linux' : process.platform,
    /(?:^|[\\/])cmd(?:\.exe)?$/i.test(shell.shellOverride ?? '') ? 'cmd' : undefined
  )
  const parsed = command && tokenizeStartupCommand(command, startupShell)
  if (!parsed || !parsed.ok || !argv) {
    return null
  }
  const executable = parsed.tokens.findIndex(
    (token) =>
      token
        .split(/[\\/]/)
        .pop()
        ?.replace(/\.(exe|cmd|bat|ps1)$/i, '') === argv[0]
  )
  const marker = argv[1].split('=')[0]
  const index = parsed.tokens.findIndex(
    (token, index) => index > executable && (token === marker || token.startsWith(`${marker}=`))
  )
  if (executable === -1 || parsed.tokens.slice(executable + 1, index).includes('--')) {
    return null
  }
  const token = parsed.tokens[index]
  const id = token?.includes('=') ? token.slice(token.indexOf('=') + 1) : parsed.tokens[index + 1]
  const session = index === -1 ? null : normalizeAgentProviderSession({ key: 'session_id', id })
  return session ? { agent, id: session.id } : null
}

function probePresence(provider: IPtyProvider, id: string): unknown {
  try {
    const result: unknown = provider.hasPty?.(id)
    // Why: the contract is synchronous; unexpected asynchronous probes are unknown.
    if (result instanceof Promise) {
      void result.catch(() => {})
    }
    return result
  } catch {
    return null
  }
}

export class ProviderConversationReservation {
  private connectionId: string | null | undefined
  private paneKey?: string | null
  private provider?: IPtyProvider
  result?: PtySpawnResult
  private unsubscribe?: () => void

  constructor(private readonly key: string) {
    this.reserve()
  }

  static acquire(
    args: ProviderConversationRequest,
    options: PtySpawnOptions,
    provider: IPtyProvider
  ): ProviderConversationReservation | undefined {
    const conversation = parseProviderConversation(
      options.launchAgent,
      options.env?.[SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV] ?? options.command,
      { connectionId: args.connectionId, shellOverride: options.shellOverride }
    )
    if (
      !conversation ||
      (options.sessionId &&
        !options.isNewSession &&
        probePresence(provider, getAppPtyId(args.connectionId, options.sessionId)) === true)
    ) {
      return
    }
    const reservation = new ProviderConversationReservation(
      JSON.stringify([conversation.agent, conversation.id])
    )
    try {
      reservation.admit(args)
      return reservation
    } catch (error) {
      reservation.release()
      throw error
    }
  }

  static retireProvider(
    provider: IPtyProvider,
    replacement?: IPtyProvider,
    ptyIds?: readonly string[]
  ): void {
    for (const entries of owners.values()) {
      for (const owner of entries) {
        const result = owner.result
        if (owner.provider !== provider || !result || (ptyIds && !ptyIds.includes(result.id))) {
          continue
        }
        if (replacement && probePresence(replacement, result.id) === true) {
          // Preserved legacy PTYs move to the replacement router without retaining the old provider.
          owner.releaseSubscription()
          owner.provider = undefined
          owner.bind(replacement, result, owner.connectionId)
        } else {
          owner.release()
        }
      }
    }
  }

  private reserve(): void {
    const entries = owners.get(this.key) ?? new Set<ProviderConversationReservation>()
    entries.add(this)
    owners.set(this.key, entries)
  }

  private admit(args: ProviderConversationRequest): void {
    const host = args.connectionId ?? null
    const paneKey = makePaneSpawnReservationKey(
      args.worktreeId,
      host,
      args.tabId && args.leafId ? makePaneKey(args.tabId, args.leafId) : null
    )
    for (const owner of owners.get(this.key) ?? []) {
      if (owner === this || owner.connectionId !== host) {
        continue
      }
      // Same-pane launches join the existing pane reservation before reaching the provider.
      if (paneKey && owner.paneKey === paneKey && paneSpawnReservationsByOwnerKey.has(paneKey)) {
        continue
      }
      let live = !owner.result
      if (owner.result) {
        try {
          live =
            (!host || getProvider(host) === owner.provider) &&
            probePresence(owner.provider!, owner.result.id) === true
        } catch {
          live = false
        }
      }
      if (live) {
        throw providerConversationConflict(args)
      }
      if (!live) {
        owner.release()
      }
    }
    this.connectionId = host
    this.paneKey = paneKey
  }

  bind(provider: IPtyProvider, result: PtySpawnResult, connectionId?: string | null): void {
    const entries = owners.get(this.key)
    if (!entries?.has(this)) {
      return
    }
    if (
      this.provider === provider &&
      this.result?.id === result.id &&
      this.result.incarnationId === result.incarnationId
    ) {
      return
    }
    for (const owner of entries) {
      if (
        owner !== this &&
        owner.provider === provider &&
        owner.result?.id === result.id &&
        owner.result.incarnationId === result.incarnationId
      ) {
        return this.release()
      }
    }
    this.connectionId = connectionId ?? null
    this.provider = provider
    this.result = result
    if (result.exitedBeforeSpawnReply) {
      return this.release()
    }
    this.unsubscribe = provider.onExit?.((event) => {
      const same = event.incarnationId
        ? event.incarnationId === result.incarnationId
        : probePresence(provider, result.id) === false
      if (event.id === result.id && !event.synthetic && same) {
        this.release()
      }
    })
  }

  release(): void {
    const entries = owners.get(this.key)
    if (!entries?.delete(this)) {
      return
    }
    if (entries.size === 0 && owners.get(this.key) === entries) {
      owners.delete(this.key)
    }
    this.releaseSubscription()
  }

  private releaseSubscription(): void {
    const unsubscribe = this.unsubscribe
    this.unsubscribe = undefined
    // The provider dispatches over a mutable listener array; removal must wait until dispatch ends.
    if (unsubscribe) {
      queueMicrotask(unsubscribe)
    }
  }
}
