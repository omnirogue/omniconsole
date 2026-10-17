// Latency telemetry: the terminal.create / terminal.split RPC handlers are the one place that
// knows a launch came from an RPC client, so only they name its cause: 'mobile-wake' for a
// phone, 'cli' for every other client. Main-internal creates never pass through here.
import { describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import { TERMINAL_METHODS } from './terminal'

function method(name: string) {
  const found = TERMINAL_METHODS.find((candidate) => candidate.name === name)
  if (!found) {
    throw new Error(`${name} method missing`)
  }
  return found
}

function createContext(clientKind: RpcContext['clientKind']) {
  const createTerminal = vi.fn(async () => ({ handle: 't', worktreeId: 'w', title: null }))
  const splitTerminal = vi.fn(async () => ({ handle: 't2', tabId: 'tab', leafId: 'leaf' }))
  const dedupeTerminalCreate = vi.fn(
    async (
      _client: string,
      _worktree: string | undefined,
      _mutationId: string | undefined,
      _reconcile: boolean,
      run: (worktree: string | undefined, handle: string | undefined) => Promise<unknown>
    ) => run('id:w', undefined)
  )
  const context = {
    runtime: { createTerminal, splitTerminal, dedupeTerminalCreate },
    ...(clientKind ? { clientKind } : {})
  } as unknown as RpcContext
  return { context, createTerminal, splitTerminal }
}

type ClientKind = RpcContext['clientKind']

const createCases: [ClientKind, string][] = [
  [undefined, 'terminal-create'],
  ['runtime', 'terminal-create'],
  ['mobile', 'terminal-create']
]

const splitCases: [ClientKind, string][] = [
  [undefined, 'terminal-split'],
  ['mobile', 'terminal-split']
]

describe('terminal RPC launch trigger', () => {
  it.each(createCases)('labels a create from a %s client as %s', async (clientKind, expected) => {
    const { context, createTerminal } = createContext(clientKind)
    const params = { worktree: 'id:w', command: 'claude' }
    await method('terminal.create').handler(params, context, vi.fn())
    expect(createTerminal).toHaveBeenCalledWith(
      'id:w',
      expect.objectContaining({ launchCause: expect.objectContaining({ trigger: expected }) })
    )
  })

  it("names one cause and one admission lane: a phone's create is the person lane", async () => {
    // #926's launch.trigger and #927's admission lane describe the same request, so they agree.
    const phone = createContext('mobile')
    await method('terminal.create').handler(
      { worktree: 'id:w', command: 'claude' },
      phone.context,
      vi.fn()
    )
    expect(phone.createTerminal).toHaveBeenCalledWith(
      'id:w',
      expect.objectContaining({
        launchCause: {
          trigger: 'terminal-create',
          actor: { kind: 'mobile', clientKind: 'mobile' }
        },
        agentLaunchPriority: 'person'
      })
    )

    // A CLI create waits in the explicit lane (never the person's), its socket kept alive.
    const cli = createContext(undefined)
    const keepAliveWhileWaiting = vi.fn()
    const context = { ...cli.context, keepAliveWhileWaiting } as unknown as RpcContext
    await method('terminal.create').handler(
      { worktree: 'id:w', command: 'claude' },
      context,
      vi.fn()
    )
    const calls = cli.createTerminal.mock.calls as unknown[][]
    const options = calls[0]?.[1] as Record<string, unknown>
    expect(options).toMatchObject({
      launchCause: { trigger: 'terminal-create', actor: { kind: 'local-cli' } },
      onAgentLaunchQueued: keepAliveWhileWaiting
    })
    expect(options).not.toHaveProperty('agentLaunchPriority')
  })

  it.each(splitCases)('labels a split from a %s client as %s', async (clientKind, expected) => {
    const { context, splitTerminal } = createContext(clientKind)
    const params = { terminal: 'term_1', command: 'claude' }
    await method('terminal.split').handler(params, context, vi.fn())
    expect(splitTerminal).toHaveBeenCalledWith(
      'term_1',
      expect.objectContaining({ launchCause: expect.objectContaining({ trigger: expected }) })
    )
  })
})
