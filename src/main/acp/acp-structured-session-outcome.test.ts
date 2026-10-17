import { describe, expect, it } from 'vitest'

import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type { AgentJournalStatusItem } from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { AcpJsonRpcConnectionHandlers } from './acp-jsonrpc-connection'
import { AcpStructuredSessionAdapter } from './acp-structured-session-adapter'
import { fakeConnection } from './acp-test-connection'

type TurnLifecycle = NonNullable<AgentJournalStatusItem['turnLifecycle']>

async function acquireSession(onPrompt: (handlers: AcpJsonRpcConnectionHandlers) => unknown) {
  const turns: TurnLifecycle[] = []
  let complete: (turn: TurnLifecycle) => void = () => undefined
  const completion = new Promise<TurnLifecycle>((resolve) => {
    complete = resolve
  })
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (_identity, body) => {
      if (body.kind === 'status' && body.turnLifecycle) {
        turns.push(body.turnLifecycle)
        if (body.turnLifecycle.state === 'completed') {
          complete(body.turnLifecycle)
        }
      }
    },
    appendTombstone: () => undefined,
    publish: () => undefined
  }
  let handlers: AcpJsonRpcConnectionHandlers = {}
  const connection = fakeConnection({
    onRequest: (method) => {
      if (method === 'session/new') {
        return { sessionId: 'grok:provider/session' }
      }
      return method === 'session/prompt' ? onPrompt(handlers) : {}
    }
  })
  const adapter = new AcpStructuredSessionAdapter({
    openConnection: async (_launch, nextHandlers) => {
      handlers = nextHandlers ?? {}
      return connection
    },
    resolveLaunch: async () => ({ command: 'grok', args: ['agent', 'stdio'], cwd: '/repo' }),
    readProcessStartTime: async () => 1
  })
  await adapter.acquire({
    identity: {
      sessionId: 'omni-outcome-session',
      workspaceId: 'folder-workspace',
      hostId: 'local',
      agent: 'grok',
      providerHandle: { kind: 'opaque', agent: 'grok', value: 'pending' }
    },
    fence: 1,
    spawnToken: 'outcome-spawn-token',
    events: sink
  })
  return {
    turns,
    completion,
    cancel: (turnId: string) =>
      adapter.cancelTurn({ sessionId: 'omni-outcome-session', fence: 1, turnId }),
    dispatch: (clientMessageId = 'message-1') =>
      adapter.dispatch({
        sessionId: 'omni-outcome-session',
        clientMessageId,
        fence: 1,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Finish the task' }] }
      })
  }
}

function promptItemId(turnId: string): string {
  return agentJournalItemKey({
    provider: 'legacy',
    agent: 'grok',
    sessionId: 'grok:provider/session',
    recordId: `${turnId}:user`
  })
}

describe('ACP turn completion evidence', () => {
  it.each([
    {
      label: 'end_turn',
      response: { stopReason: 'end_turn' },
      outcome: 'succeeded',
      turnOutcome: 'completed'
    },
    {
      label: 'cancelled',
      response: { stopReason: 'cancelled' },
      outcome: 'cancelled',
      turnOutcome: 'interrupted'
    },
    {
      label: 'max_tokens',
      response: { stopReason: 'max_tokens' },
      outcome: 'unknown',
      turnOutcome: 'unknown'
    },
    {
      label: 'max_turn_requests',
      response: { stopReason: 'max_turn_requests' },
      outcome: 'unknown',
      turnOutcome: 'unknown'
    },
    {
      label: 'refusal',
      response: { stopReason: 'refusal' },
      outcome: 'unknown',
      turnOutcome: 'unknown'
    },
    {
      label: 'an unknown stop reason',
      response: { stopReason: 'vendor_stop' },
      outcome: 'unknown',
      turnOutcome: 'unknown'
    },
    { label: 'a missing stop reason', response: {}, outcome: 'unknown', turnOutcome: 'unknown' },
    {
      label: 'a missing response',
      response: undefined,
      outcome: 'unknown',
      turnOutcome: 'unknown'
    },
    { label: 'a null response', response: null, outcome: 'unknown', turnOutcome: 'unknown' },
    {
      label: 'a bare string response',
      response: 'end_turn',
      outcome: 'unknown',
      turnOutcome: 'unknown'
    },
    {
      label: 'a malformed stop reason',
      response: { stopReason: true },
      outcome: 'unknown',
      turnOutcome: 'unknown'
    }
  ])(
    'records $outcome for $label against the exact prompt receipt',
    async ({ response, outcome, turnOutcome }) => {
      const session = await acquireSession(() => response)

      const dispatched = await session.dispatch()

      expect(dispatched.state).toBe('accepted')
      if (dispatched.state !== 'accepted') {
        throw new Error(`Prompt was ${dispatched.state}`)
      }
      const running = session.turns.find((turn) => turn.state === 'running')
      expect(running).toBeDefined()
      expect(running?.settlement).toBeUndefined()
      expect(session.turns.filter((turn) => turn.state === 'completed')).toEqual([
        {
          turnId: running?.turnId,
          state: 'completed',
          // PR #289 added the turn-level `outcome` beside PR #283's `settlement`; both
          // readings of the same ending are written, so both are asserted here.
          outcome: turnOutcome,
          settlement: {
            providerItemId: agentJournalItemKey(dispatched.providerIdentity),
            outcome
          }
        }
      ])
      expect(agentJournalItemKey(dispatched.providerIdentity)).toBe(promptItemId(running!.turnId))
    }
  )

  it('records a failed prompt request without claiming successful completion', async () => {
    const session = await acquireSession(() => {
      throw new Error('Provider rejected the prompt')
    })

    expect(await session.dispatch()).toEqual({
      state: 'unknown',
      reason: 'Provider rejected the prompt'
    })
    const running = session.turns.find((turn) => turn.state === 'running')
    expect(running).toBeDefined()
    expect(session.turns.filter((turn) => turn.state === 'completed')).toEqual([
      {
        turnId: running?.turnId,
        state: 'completed',
        outcome: 'failed',
        settlement: { providerItemId: promptItemId(running!.turnId), outcome: 'failed' }
      }
    ])
  })

  it('keeps a cancelled turn cancelled when the provider subsequently reports end_turn', async () => {
    let finishPrompt: (response: unknown) => void = () => undefined
    const pendingPrompt = new Promise<unknown>((resolve) => {
      finishPrompt = resolve
    })
    const session = await acquireSession((handlers) => {
      handlers.onNotification?.('session/update', {
        sessionId: 'grok:provider/session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Working on the task' }
        }
      })
      return pendingPrompt
    })

    const dispatched = await session.dispatch()

    expect(dispatched.state).toBe('accepted')
    if (dispatched.state !== 'accepted') {
      throw new Error(`Prompt was ${dispatched.state}`)
    }
    const running = session.turns.find((turn) => turn.state === 'running')
    expect(running).toBeDefined()
    expect(await session.cancel(running!.turnId)).toEqual({ cancelled: true })
    expect(session.turns.some((turn) => turn.state === 'completed')).toBe(false)

    finishPrompt({ stopReason: 'end_turn' })

    expect(await session.completion).toEqual({
      turnId: running?.turnId,
      state: 'completed',
      outcome: 'interrupted',
      settlement: {
        providerItemId: agentJournalItemKey(dispatched.providerIdentity),
        outcome: 'cancelled'
      }
    })
    expect(session.turns.some((turn) => turn.settlement?.outcome === 'succeeded')).toBe(false)
  })

  it('records unknown when the provider exits before the prompt request settles', async () => {
    let atExit: TurnLifecycle | undefined
    const session = await acquireSession((handlers) => {
      expect(handlers.onExit).toBeTypeOf('function')
      handlers.onExit?.(new Error('Provider process exited'))
      atExit = session.turns.at(-1)
      throw new Error('Connection closed before a prompt response')
    })

    await session.dispatch()

    const running = session.turns.find((turn) => turn.state === 'running')
    expect(running).toBeDefined()
    expect(atExit).toEqual({
      turnId: running?.turnId,
      state: 'completed',
      outcome: 'unknown',
      settlement: { providerItemId: promptItemId(running!.turnId), outcome: 'unknown' }
    })
    expect(session.turns.some((turn) => turn.settlement?.outcome === 'succeeded')).toBe(false)
  })

  it('keeps consecutive prompt settlements bound to their own receipts', async () => {
    const session = await acquireSession(() => ({ stopReason: 'end_turn' }))

    const first = await session.dispatch('first-message')
    const second = await session.dispatch('second-message')

    expect(first.state).toBe('accepted')
    expect(second.state).toBe('accepted')
    if (first.state !== 'accepted' || second.state !== 'accepted') {
      throw new Error('Both prompts must be accepted')
    }
    const firstReceipt = agentJournalItemKey(first.providerIdentity)
    const secondReceipt = agentJournalItemKey(second.providerIdentity)
    expect(firstReceipt).not.toBe(secondReceipt)
    expect(
      session.turns.filter((turn) => turn.state === 'completed').map((turn) => turn.settlement)
    ).toEqual([
      { providerItemId: firstReceipt, outcome: 'succeeded' },
      { providerItemId: secondReceipt, outcome: 'succeeded' }
    ])
  })
})
