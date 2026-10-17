import { beforeEach, describe, expect, it, vi } from 'vitest'

const attach = vi.hoisted(() => vi.fn())
vi.mock('../../session-contract-verify', () => ({ attachContractVerify: attach }))

const { AGENT_SESSION_CONTRACT_METHODS } = await import('./agent-session-contract')

const method = AGENT_SESSION_CONTRACT_METHODS[0]!
const schema = method.params!
const PARAMS = {
  terminal: 'term_new',
  title: 'Fix the login timeout',
  acceptance: ['pnpm test auth exits 0'],
  agent: 'codex' as const
}

function runtime(paneKey: string | null) {
  return {
    getTerminalPaneKey: () => paneKey,
    getTerminalWorktreeIdForPaneKey: () => (paneKey ? 'repo::/w' : null)
  }
}

beforeEach(() => {
  attach.mockReset().mockResolvedValue({ attached: true })
})

describe('agentSession.attachContractVerify', () => {
  it('binds the launched pane and answers with the binding result', async () => {
    const params = schema.parse(PARAMS)
    await expect(
      method.handler(params, { runtime: runtime('tab:leaf') } as never)
    ).resolves.toEqual({ attached: true })
    expect(attach).toHaveBeenCalledWith(expect.anything(), {
      worktreeId: 'repo::/w',
      paneKey: 'tab:leaf',
      title: 'Fix the login timeout',
      doneWhen: ['pnpm test auth exits 0'],
      agent: 'codex',
      label: 'A'
    })
  })

  it('refuses empty Acceptance and an agent it cannot launch', () => {
    expect(() => schema.parse({ ...PARAMS, acceptance: [] })).toThrow()
    expect(() => schema.parse({ ...PARAMS, agent: 'grok' })).toThrow()
  })

  it('refuses a terminal that never gets a conversation identity', async () => {
    vi.useFakeTimers()
    try {
      const pending = method.handler(schema.parse(PARAMS), {
        runtime: runtime(null)
      } as never)
      const settled = expect(pending).rejects.toThrow('no conversation identity')
      await vi.advanceTimersByTimeAsync(11_000)
      await settled
      expect(attach).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
