import { describe, expect, it, vi } from 'vitest'

vi.mock('./session-decision-wiring', () => ({ listSessionDecisions: () => [] }))
vi.mock('../session-manage/session-manage-runtime-actions', () => ({ readSidebarRows: vi.fn() }))
vi.mock('../local-host-label', () => ({ localHostLabel: () => 'host' }))
vi.mock('./omnios-question-runtime', () => ({ startOmniosQuestionsSync: vi.fn() }))

const { applyOmniosAnswer } = await import('./omnios-question-apply')

const PROMPT = '{"questions":[]}'
const decision = { paneKey: 'tab:pane', worktreeId: 'wt', interactivePrompt: PROMPT }
const answer = {
  id: '7',
  fingerprint: 'fp',
  paneKey: 'tab:pane',
  sessionId: 's',
  toolUseId: null,
  answers: { 'Depth?': 'Full', 'PR links?': 'Open, Drafts' },
  skipped: false
}

function runtime(reply: () => Promise<unknown>, prompt: string | null = PROMPT) {
  return {
    resolveTerminalPane: vi.fn(() => ({ handle: 'h1' })),
    getFreshAgentHookStatusForHandle: vi.fn(() => (prompt ? { interactivePrompt: prompt } : null)),
    requestSessionFolders: vi.fn(reply)
  }
}

const find = () => decision as never

describe('applyOmniosAnswer', () => {
  it('relays every answer (and skip) to the window card send and acks its confirmation', async () => {
    const rt = runtime(async () => ({ delivered: true }))
    expect(await applyOmniosAnswer(rt as never, answer as never, find)).toEqual({ delivered: true })
    expect(rt.requestSessionFolders).toHaveBeenCalledWith({
      kind: 'answerOmniosQuestion',
      paneKey: 'tab:pane',
      interactivePrompt: PROMPT,
      answers: answer.answers,
      skipped: false
    })
    await applyOmniosAnswer(rt as never, { ...answer, answers: {}, skipped: true } as never, find)
    expect(rt.requestSessionFolders).toHaveBeenLastCalledWith(
      expect.objectContaining({ skipped: true, answers: {} })
    )
  })

  it('passes the window refusal back as not delivered', async () => {
    const rt = runtime(async () => ({ delivered: false, error: 'partly typed' }))
    expect(await applyOmniosAnswer(rt as never, answer as never, find)).toEqual({
      delivered: false,
      error: 'partly typed'
    })
  })

  it('never acks delivered on a relay failure or an old window reply', async () => {
    const failed = runtime(async () => {
      throw new Error('timed out')
    })
    expect(await applyOmniosAnswer(failed as never, answer as never, find)).toMatchObject({
      delivered: false
    })
    const old = runtime(async () => undefined)
    expect(await applyOmniosAnswer(old as never, answer as never, find)).toMatchObject({
      delivered: false,
      error: expect.stringMatching(/reload/)
    })
  })

  it('types nothing when the pane no longer asks this question', async () => {
    const moved = runtime(async () => ({ delivered: true }), '{"questions":[{"other":1}]}')
    expect(await applyOmniosAnswer(moved as never, answer as never, find)).toMatchObject({
      delivered: false
    })
    expect(moved.requestSessionFolders).not.toHaveBeenCalled()
    const gone = runtime(async () => ({ delivered: true }))
    expect(await applyOmniosAnswer(gone as never, answer as never, () => undefined)).toMatchObject({
      delivered: false
    })
    expect(gone.requestSessionFolders).not.toHaveBeenCalled()
  })
})

const QUESTIONS = [
  {
    question: 'Who pushes the backend to production?',
    header: 'Who ships',
    multiSelect: false,
    options: [{ label: 'Uma ships it' }, { label: 'This session ships it' }]
  }
]
const SELECTOR = [
  'Who ships',
  'Who pushes the backend to production?',
  '❯ 1. Uma ships it',
  '  2. This session ships it',
  'Enter to select · ↑/↓ to navigate · Esc to cancel'
]
const findAsking = () => ({ ...decision, questions: QUESTIONS }) as never

/** A pane whose question is known only from an old or restored report. */
function oldReport(agentType: string, read: () => Promise<unknown>) {
  return {
    resolveTerminalPane: vi.fn(() => ({ handle: 'h1' })),
    getFreshAgentHookStatusForHandle: vi.fn(() => ({
      interactivePrompt: PROMPT,
      unconfirmedAsk: true,
      agentType
    })),
    readTerminal: vi.fn(read),
    requestSessionFolders: vi.fn(async () => ({ delivered: true }))
  }
}

describe('applyOmniosAnswer for a question known only from an old or restored report', () => {
  it('answers through the card when this host’s screen shows the selector', async () => {
    const rt = oldReport('claude', async () => ({ source: 'screen', tail: SELECTOR, draft: '' }))
    expect(await applyOmniosAnswer(rt as never, answer as never, findAsking)).toEqual({
      delivered: true
    })
    expect(rt.getFreshAgentHookStatusForHandle).toHaveBeenCalledWith('h1', { openAsk: true })
    expect(rt.readTerminal).toHaveBeenCalledWith('h1', { screen: true })
    expect(rt.requestSessionFolders).toHaveBeenCalledWith(
      expect.not.objectContaining({ confirmOnScreen: true })
    )
  })

  it('types nothing when the screen shows no selector, so the answer goes as a message', async () => {
    const rt = oldReport('claude', async () => ({ source: 'screen', tail: ['> '], draft: '' }))
    expect(await applyOmniosAnswer(rt as never, answer as never, findAsking)).toMatchObject({
      delivered: false,
      error: expect.stringMatching(/no longer waiting/)
    })
    expect(rt.requestSessionFolders).not.toHaveBeenCalled()
  })

  const unconfirmable: [string, string, () => Promise<unknown>][] = [
    ['this host has no screen for it', 'claude', async () => ({ source: 'stream', tail: [] })],
    [
      'the read fails',
      'claude',
      async () => {
        throw new Error('detached')
      }
    ],
    ['the agent is not Claude', 'codex', async () => ({ source: 'screen', tail: SELECTOR })]
  ]
  it.each(unconfirmable)(
    'leaves the screen check to the window when %s',
    async (_, agent, read) => {
      const rt = oldReport(agent, read)
      expect(await applyOmniosAnswer(rt as never, answer as never, findAsking)).toEqual({
        delivered: true
      })
      expect(rt.requestSessionFolders).toHaveBeenCalledWith(
        expect.objectContaining({ confirmOnScreen: true })
      )
    }
  )
})
