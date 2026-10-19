import { describe, expect, it, vi } from 'vitest'

vi.mock('../../session-contract-verify', () => ({ attachContractVerify: vi.fn() }))

const { AGENT_SESSION_CONTRACT_METHODS } = await import('./agent-session-contract')

// #1214: `omni session launch --ephemeral` arms When finished -> End through this method.
describe('agentSession.scheduleFinish on the executing host', () => {
  const method = AGENT_SESSION_CONTRACT_METHODS.find(
    (entry) => entry.name === 'agentSession.scheduleFinish'
  )!
  const schema = method.params!

  function runtime(paneKey: string | null) {
    const requestSessionFolders = vi.fn(async () => ({ scheduled: true }))
    return { requestSessionFolders, getTerminalPaneKey: () => paneKey }
  }

  it('accepts End, Archive or a clear, and nothing else', () => {
    for (const action of ['end', 'archive', null]) {
      expect(schema.parse({ terminal: 'term_new', action })).toEqual({
        terminal: 'term_new',
        action
      })
    }
    expect(() => schema.parse({ terminal: 'term_new', action: 'delete' })).toThrow()
    expect(() => schema.parse({ terminal: 'term_new' })).toThrow()
    expect(() => schema.parse({ terminal: '', action: 'end' })).toThrow()
    expect(() => schema.parse({ terminal: 'term_new', action: 'end', paneKey: 'x' })).toThrow()
  })

  it("relays the launched pane's choice to its window and answers with the window's reply", async () => {
    const host = runtime('tab:leaf')
    await expect(
      method.handler(schema.parse({ terminal: 'term_new', action: 'end' }), {
        runtime: host
      } as never)
    ).resolves.toEqual({ scheduled: true })
    expect(host.requestSessionFolders).toHaveBeenCalledWith({
      kind: 'scheduleFinish',
      paneKey: 'tab:leaf',
      action: 'end'
    })
  })

  it('refuses a terminal that never gets a conversation identity, scheduling nothing', async () => {
    vi.useFakeTimers()
    try {
      const host = runtime(null)
      const pending = method.handler(schema.parse({ terminal: 'term_new', action: 'end' }), {
        runtime: host
      } as never)
      const settled = expect(pending).rejects.toThrow('no conversation identity')
      await vi.advanceTimersByTimeAsync(11_000)
      await settled
      expect(host.requestSessionFolders).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

// Sal, 2026-10-19: every `omni session launch` is an agent's, listed in Agent sessions.
describe('agentSession.markAgentSession on the executing host', () => {
  const method = AGENT_SESSION_CONTRACT_METHODS.find(
    (entry) => entry.name === 'agentSession.markAgentSession'
  )!
  const schema = method.params!

  it('takes the launched terminal only', () => {
    expect(schema.parse({ terminal: 'term_new' })).toEqual({ terminal: 'term_new' })
    expect(() => schema.parse({ terminal: '' })).toThrow()
    expect(() => schema.parse({ terminal: 'term_new', paneKey: 'x' })).toThrow()
  })

  it('notes the launched pane on its window, retried there, and answers at once', async () => {
    const requestSessionFolders = vi.fn(async () => ({ marked: true }))
    await expect(
      method.handler(schema.parse({ terminal: 'term_new' }), {
        runtime: { requestSessionFolders, getTerminalPaneKey: () => 'tab:leaf' }
      } as never)
    ).resolves.toEqual({ noted: true })
    expect(requestSessionFolders).toHaveBeenCalledWith({
      kind: 'markAgentSession',
      paneKey: 'tab:leaf'
    })
  })
})
