import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  claimTerminalKeyboardSubmit,
  recordTerminalKeyboardSubmit,
  resetTerminalKeyboardSubmitsForTests
} from './terminal-keyboard-submits'
import type { SessionPrepBatchView } from '../../shared/session-prep-types'
import type { SessionPrepCheckedRequest } from './session-prep-requests'
import {
  createTerminalPromptInterceptor,
  type TerminalInterceptDeps,
  type TerminalPromptEvent
} from './session-prep-terminal-intercept'

const PANE = 'tab-1:leaf-1'

function batch(state: SessionPrepBatchView['state'], launched = 0): SessionPrepBatchView {
  return {
    id: 'sp_1',
    createdAt: 1,
    state,
    source: { worktreeId: 'wt-1', paneKey: PANE, agent: 'claude' },
    request: 'create sessions for a and b',
    items: Array.from({ length: launched }, (_, index) => ({
      index,
      title: `item ${index}`,
      state: 'launched' as const,
      direct: false,
      repairs: 0
    })),
    notes: []
  }
}

function setup(over: Partial<TerminalInterceptDeps> = {}) {
  const service = {
    requestFromTerminal: vi.fn(async (): Promise<SessionPrepCheckedRequest> => ({
      outcome: 'started',
      batchId: 'sp_new'
    })),
    listForSource: vi.fn(() => [batch('running', 1)]),
    cancel: vi.fn(async () => batch('done', 1))
  }
  const claim = { submittedAt: 1 }
  const deps: TerminalInterceptDeps = {
    service: () => service,
    ptyIdForPaneKey: () => 'pty-1',
    worktreeIdForPaneKey: () => 'wt-1',
    claimKeyboardSubmit: () => claim,
    readContext: vi.fn(async () => 'User: earlier ask'),
    ...over
  }
  return { intercept: createTerminalPromptInterceptor(deps), service, deps }
}

const event = (prompt: string, over: Partial<TerminalPromptEvent> = {}): TerminalPromptEvent => ({
  paneKey: PANE,
  worktreeId: 'wt-1',
  payload: { prompt },
  providerSession: { transcriptPath: '/tmp/t.jsonl' },
  ...over
})

describe('createTerminalPromptInterceptor', () => {
  beforeEach(resetTerminalKeyboardSubmitsForTests)
  it('routes a first objective when the transcript already contains that submitted message', async () => {
    const prompt = 'I want you to research three reputable suppliers for insulated coffee cups'
    const { intercept, service } = setup({ readContext: async () => `User: ${prompt}` })
    expect((await intercept('claude', event(prompt)))?.decision).toBe('block')
    expect(service.requestFromTerminal).toHaveBeenCalledTimes(1)
  })

  it('keeps an ongoing correction in its current session and honors the off switch', async () => {
    const prompt = 'I want you to research three reputable suppliers for insulated coffee cups'
    const ongoing = setup()
    expect(await ongoing.intercept('claude', event(prompt))).toBeNull()
    const disabled = setup({ readContext: async () => '', automaticDispatch: () => false })
    expect(await disabled.intercept('claude', event(prompt))).toBeNull()
    expect(disabled.service.requestFromTerminal).not.toHaveBeenCalled()
  })

  it('preserves a chosen terminal for plain imperatives and unknown conversation context', async () => {
    const plain = setup({ readContext: async () => '' })
    expect(
      await plain.intercept(
        'claude',
        event('Research three reputable suppliers for insulated coffee cups')
      )
    ).toBeNull()
    const unreadable = setup({
      readContext: async () => {
        throw new Error('unavailable')
      }
    })
    expect(
      await unreadable.intercept(
        'claude',
        event('I want you to research three reputable suppliers for insulated coffee cups')
      )
    ).toBeNull()
    expect(unreadable.service.requestFromTerminal).not.toHaveBeenCalled()
  })

  it('diverts the person’s own session request with the conversation excerpt', async () => {
    const { intercept, service } = setup()
    const reply = await intercept('claude', event('ok launch a session to fix the login bug'))

    expect(reply?.decision).toBe('block')
    expect(reply?.reason).toContain('sp_new')
    expect(service.requestFromTerminal).toHaveBeenCalledWith({
      text: 'ok launch a session to fix the login bug',
      source: { worktreeId: 'wt-1', paneKey: PANE, agent: 'claude' },
      context: 'User: earlier ask'
    })
  })

  it("files a request typed in a project's thread in that project, and still prepares without one", async () => {
    const inProject = setup({ projectForPane: vi.fn(async () => 'project-1') })
    await inProject.intercept('claude', event('create sessions for a and b'))
    expect(inProject.service.requestFromTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ defaultFolder: 'project-1' })
    )
    expect(inProject.deps.projectForPane).toHaveBeenCalledWith(PANE)

    const unread = setup({
      projectForPane: vi.fn(async () => {
        throw new Error('Finding a terminal’s project requires an updated OmniConsole window.')
      })
    })
    expect((await unread.intercept('claude', event('create sessions for a and b')))?.decision).toBe(
      'block'
    )
    expect(unread.service.requestFromTerminal).toHaveBeenCalledWith(
      expect.not.objectContaining({ defaultFolder: expect.anything() })
    )
  })

  it('lets through anything that is not provably the person’s own session request', async () => {
    const notTyped = setup({ claimKeyboardSubmit: () => null })
    expect(await notTyped.intercept('claude', event('create sessions for a and b'))).toBeNull()

    const plain = setup()
    expect(await plain.intercept('claude', event('fix the login bug'))).toBeNull()
    expect(await plain.intercept('codex', event('create sessions for a and b'))).toBeNull()
    expect(
      await plain.intercept(
        'claude',
        event(
          'Create sessions for a\n\nPrepared by OmniConsole from your message (batch sp_1, item 1).'
        )
      )
    ).toBeNull()

    const noPty = setup({ ptyIdForPaneKey: () => null })
    expect(await noPty.intercept('claude', event('create sessions for a and b'))).toBeNull()

    const noWorktree = setup({ worktreeIdForPaneKey: () => null })
    expect(
      await noWorktree.intercept('claude', event('create sessions for a and b', { worktreeId: '' }))
    ).toBeNull()
    expect(plain.service.requestFromTerminal).not.toHaveBeenCalled()
  })

  it('accepts a just-pressed Enter when the typed line cannot be matched', async () => {
    recordTerminalKeyboardSubmit('pty-1', 'create sesions')
    const { intercept, service } = setup({ claimKeyboardSubmit: claimTerminalKeyboardSubmit })
    expect((await intercept('claude', event('create sessions for a and b')))?.decision).toBe(
      'block'
    )
    expect(service.requestFromTerminal).toHaveBeenCalled()
  })

  it('returns the same block for a replay without launching another batch', async () => {
    recordTerminalKeyboardSubmit('pty-1', 'create sessions for a and b')
    const { intercept, service } = setup({ claimKeyboardSubmit: claimTerminalKeyboardSubmit })
    const first = await intercept('claude', event('create sessions for a and b'))
    const replay = await intercept('claude', event('create sessions for a and b'))
    expect(replay).toEqual(first)
    expect(replay?.decision).toBe('block')
    expect(service.requestFromTerminal).toHaveBeenCalledTimes(1)
  })

  it('joins a replay while transcript reading is still in flight', async () => {
    recordTerminalKeyboardSubmit('pty-1', 'create sessions for a and b')
    let release!: (text: string) => void
    const context = new Promise<string>((resolve) => {
      release = resolve
    })
    const { intercept, service, deps } = setup({
      claimKeyboardSubmit: claimTerminalKeyboardSubmit,
      readContext: vi.fn(() => context)
    })
    const first = intercept('claude', event('create sessions for a and b'))
    const replay = intercept('claude', event('create sessions for a and b'))
    release('User: earlier ask')
    expect(await replay).toEqual(await first)
    expect(deps.readContext).toHaveBeenCalledTimes(1)
    expect(service.requestFromTerminal).toHaveBeenCalledTimes(1)
  })

  it('allows a new typed submission of the same request', async () => {
    const { intercept, service } = setup({ claimKeyboardSubmit: claimTerminalKeyboardSubmit })
    recordTerminalKeyboardSubmit('pty-1', 'create sessions for a and b')
    await intercept('claude', event('create sessions for a and b'))
    recordTerminalKeyboardSubmit('pty-1', 'create sessions for a and b')
    await intercept('claude', event('create sessions for a and b'))
    expect(service.requestFromTerminal).toHaveBeenCalledTimes(2)
  })

  it('still diverts when the transcript cannot be read', async () => {
    const { intercept, service } = setup({
      readContext: async () => {
        throw new Error('gone')
      }
    })
    await intercept('claude', event('create sessions for a and b'))
    expect(service.requestFromTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ context: '' })
    )
  })

  it('says where sessions start when the terminal workspace was not available', async () => {
    const { intercept, service } = setup()
    service.requestFromTerminal.mockResolvedValueOnce({
      outcome: 'started',
      batchId: 'sp_new',
      startedIn: '/Users/me/Work'
    })
    const reply = await intercept('claude', event('launch a session to clean stale containers'))
    expect(reply?.reason).toContain('sp_new')
    expect(reply?.reason).toContain('start from /Users/me/Work')
  })

  it('sends the message to the agent when session prep could not start', async () => {
    const refused = setup()
    refused.service.requestFromTerminal.mockResolvedValueOnce({
      outcome: 'not-started',
      batchId: 'sp_new',
      reason: 'That workspace is not available for session prep.'
    })
    expect(await refused.intercept('claude', event('create sessions for a and b'))).toBeNull()

    const broken = setup()
    broken.service.requestFromTerminal.mockRejectedValueOnce(new Error('store unavailable'))
    expect(await broken.intercept('claude', event('create sessions for a and b'))).toBeNull()
  })

  it('names the existing batch for a repeat instead of starting another', async () => {
    const { intercept, service } = setup()
    service.requestFromTerminal.mockResolvedValueOnce({
      outcome: 'already-requested',
      batchId: 'sp_old'
    })
    const reply = await intercept('claude', event('create sessions for a and b'))
    expect(reply?.decision).toBe('block')
    expect(reply?.reason).toContain('already has this message (sp_old)')
  })

  it('undoes the open batch from this terminal', async () => {
    const { intercept, service } = setup()
    const reply = await intercept('claude', event('undo sessions'))
    expect(service.cancel).toHaveBeenCalledWith('sp_1')
    expect(reply?.reason).toContain('1 session(s) had already launched')

    const idle = setup({})
    idle.service.listForSource.mockReturnValue([batch('done')])
    expect((await idle.intercept('claude', event('cancel sessions')))?.reason).toContain(
      'nothing to undo'
    )
  })
})
