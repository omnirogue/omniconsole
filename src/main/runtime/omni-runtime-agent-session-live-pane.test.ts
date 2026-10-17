import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './omni-runtime'
import { selectProviderSessionPtyCandidates } from './live-provider-session-pty'

// Why: the runtime builds this on its first microtask; it needs app paths these tests never set.
vi.mock('../session-prep/session-prep-runtime-service', () => ({
  createRuntimeSessionPrepService: () => ({ start: async () => {} })
}))

const TAB_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `${TAB_ID}:22222222-2222-4222-8222-222222222222`
const SESSION_ID = 'abbed8e3-45f3-43a2-99fd-2064432252f5'

function hookRow(sessionId: string, overrides: Record<string, unknown> = {}) {
  return {
    paneKey: PANE_KEY,
    agentType: 'claude',
    state: 'done',
    prompt: '',
    receivedAt: Date.now(),
    providerSession: { key: 'session_id', id: sessionId },
    ...overrides
  }
}

function createRuntime(opts: { rows: unknown[]; foreground: string | null }) {
  const runtime = new OrcaRuntimeService(
    {
      getSettings: () => ({
        disabledTuiAgents: [],
        agentCmdOverrides: {},
        agentDefaultArgs: {},
        agentDefaultEnv: {}
      })
    } as never,
    undefined,
    {
      getAgentProviderSessionRowsForPane: (paneKey: string) =>
        opts.rows.filter((row) => (row as { paneKey: string }).paneKey === paneKey)
    } as never
  )
  const internal = runtime as unknown as {
    resolveTerminalWorkspaceLaunchScope: ReturnType<typeof vi.fn>
    markLocalWorkspaceTrustedForAgent: ReturnType<typeof vi.fn>
    markRemoteWorkspaceTrustedForAgent: ReturnType<typeof vi.fn>
    recordPtyWorktree: (ptyId: string, worktreeId: string, state: Record<string, unknown>) => void
  }
  internal.resolveTerminalWorkspaceLaunchScope = vi.fn(async () => ({
    id: 'worktree-1',
    path: '/tmp/worktree-1',
    connectionId: null
  }))
  internal.markLocalWorkspaceTrustedForAgent = vi.fn()
  internal.markRemoteWorkspaceTrustedForAgent = vi.fn()
  const getForegroundProcess = vi.fn(async () => opts.foreground)
  runtime.setPtyController({ getForegroundProcess } as never)
  // An automation started this conversation in a pane of its own; no claim names it.
  internal.recordPtyWorktree('pty-automation', 'worktree-1', {
    connected: true,
    tabId: TAB_ID,
    paneKey: PANE_KEY,
    title: 'Claude Code'
  })
  const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
    handle: 'term_new',
    tabId: 'placement-tab',
    paneKey: 'placement-tab:leaf',
    ptyId: 'pty-new',
    worktreeId: 'worktree-1',
    title: null,
    surface: 'background'
  })
  return { runtime, createTerminal, getForegroundProcess }
}

function resume(runtime: OrcaRuntimeService) {
  return runtime.ensureAgentSession(
    {
      kind: 'explicit',
      worktree: 'id:worktree-1',
      agent: 'claude',
      providerSession: { key: 'session_id', id: SESSION_ID },
      placement: { tabId: 'placement-tab', leafId: 'leaf' }
    },
    { clientKind: 'runtime' } as never
  )
}

describe('ensureAgentSession on a conversation that is already running', () => {
  it('hands back the live pane instead of starting a second copy', async () => {
    const { runtime, createTerminal } = createRuntime({
      rows: [hookRow(SESSION_ID)],
      foreground: 'claude'
    })
    const result = await resume(runtime)
    expect(createTerminal).not.toHaveBeenCalled()
    expect(result.disposition).toBe('adopted')
    expect(result.terminal).toMatchObject({
      tabId: TAB_ID,
      paneKey: PANE_KEY,
      ptyId: 'pty-automation',
      worktreeId: 'worktree-1',
      isReattach: true,
      agentSessionDisposition: 'adopted'
    })
    expect(result.terminal.handle).toEqual(expect.any(String))
  })

  it('resumes when the pane has dropped back to its shell', async () => {
    const { runtime, createTerminal } = createRuntime({
      rows: [hookRow(SESSION_ID)],
      foreground: 'zsh'
    })
    const result = await resume(runtime)
    expect(createTerminal).toHaveBeenCalledOnce()
    expect(result.terminal.ptyId).toBe('pty-new')
  })

  it('resumes when the foreground cannot be read', async () => {
    const { runtime, createTerminal } = createRuntime({
      rows: [hookRow(SESSION_ID)],
      foreground: null
    })
    await resume(runtime)
    expect(createTerminal).toHaveBeenCalledOnce()
  })

  it('resumes when the pane has moved on to another conversation', async () => {
    const { runtime, createTerminal, getForegroundProcess } = createRuntime({
      rows: [
        hookRow(SESSION_ID, { receivedAt: Date.now() - 60_000 }),
        hookRow('another-conversation')
      ],
      foreground: 'claude'
    })
    await resume(runtime)
    expect(getForegroundProcess).not.toHaveBeenCalled()
    expect(createTerminal).toHaveBeenCalledOnce()
  })
})

describe('selectProviderSessionPtyCandidates', () => {
  const base = { connected: true, lastOutputAt: 1, worktreeId: 'w' }
  const pane = (id: string) => ({ ...base, ptyId: id, tabId: `t-${id}`, paneKey: `t-${id}:l` })
  const sessionFor: Record<string, { agent: string; id: string }> = {
    't-a:l': { agent: 'claude', id: 's' },
    't-b:l': { agent: 'claude', id: 's' },
    't-c:l': { agent: 'codex', id: 's' },
    't-d:l': { agent: 'claude', id: 's' }
  }
  const select = (ptys: ReturnType<typeof pane>[]) =>
    selectProviderSessionPtyCandidates({
      ptys,
      worktreeId: 'w',
      agent: 'claude',
      providerSessionId: 's',
      worktreeIdsEqual: (left, right) => left === right,
      paneProviderSession: (paneKey) => ({
        agent: sessionFor[paneKey]?.agent ?? null,
        providerSession: sessionFor[paneKey]
          ? { key: 'session_id', id: sessionFor[paneKey].id }
          : null
      })
    }).map((pty) => pty.ptyId)

  it('keeps connected panes of this workspace carrying this agent and conversation', () => {
    expect(
      select([
        pane('a'),
        { ...pane('b'), connected: false },
        pane('c'),
        { ...pane('d'), worktreeId: 'other' },
        { ...pane('e') }
      ])
    ).toEqual(['a'])
  })

  it('tries the most recently active pane first', () => {
    expect(select([pane('a'), { ...pane('b'), lastOutputAt: 9 }])).toEqual(['b', 'a'])
  })
})
