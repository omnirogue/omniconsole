import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch'
import { outcomeWaitHandlers } from './outcome-wait'

const response = (result: unknown) => ({ id: 'rpc', ok: true, result })

function setup(capabilities: Record<string, unknown>, sessions: unknown[]) {
  const call = vi.fn(async (method: string) => {
    if (method === 'sessionChain.outcomeCapabilities') {
      return response({ version: 1, durableContinuation: true, ...capabilities })
    }
    if (method === 'sessionManage.list') {
      return response({ sessions })
    }
    throw new Error(`Unexpected RPC ${method}`)
  })
  const flags = new Map<string, string | boolean>()
  return {
    call,
    flags,
    context: { client: { call }, flags, json: true } as unknown as HandlerContext
  }
}

const billing = { paneKey: 'tab-2:leaf-2', title: 'Billing', hostId: 'local', state: 'working' }

describe('omni outcome wait --on-session', () => {
  let printed: string[]
  beforeEach(() => {
    printed = []
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      printed.push(String(line))
    })
    process.env.ORCA_PANE_KEY = 'tab-1:leaf-1'
  })
  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.ORCA_PANE_KEY
  })

  it('prints the event for a local session another may wait on', async () => {
    const { flags, context } = setup({ sessionWaits: 1 }, [billing])
    flags.set('on-session', 'tab-2:leaf-2')
    await outcomeWaitHandlers['outcome wait']!(context)
    expect(JSON.parse(printed.join('')).result).toEqual({
      event: { source: 'session', match: 'result', ref: 'tab-2:leaf-2' },
      label: 'Billing finishes',
      title: 'Billing',
      state: 'working'
    })
  })

  it('is refused by an older host, in words that say to update it', async () => {
    const { call, flags, context } = setup({ eventWaits: 1 }, [billing])
    flags.set('on-session', 'tab-2:leaf-2')
    await expect(outcomeWaitHandlers['outcome wait']!(context)).rejects.toThrow(
      "This OmniConsole cannot wait on another session's result. Update it, then file the wait again."
    )
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('refuses this conversation itself and a session on another computer', async () => {
    const self = setup({ sessionWaits: 1 }, [billing])
    self.flags.set('on-session', 'tab-1:leaf-1')
    await expect(outcomeWaitHandlers['outcome wait']!(self.context)).rejects.toThrow(
      'a session cannot wait on its own result'
    )
    const remote = setup({ sessionWaits: 1 }, [{ ...billing, hostId: 'ssh:devbox' }])
    remote.flags.set('on-session', 'tab-2:leaf-2')
    await expect(outcomeWaitHandlers['outcome wait']!(remote.context)).rejects.toThrow(
      '“Billing” does not run on this computer'
    )
  })
})
