import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state: {
  agentStatusByPaneKey: Record<string, unknown>
  terminalLayoutsByTabId: Record<string, { ptyIdsByLeafId: Record<string, string> }>
} = { agentStatusByPaneKey: {}, terminalLayoutsByTabId: {} }

const sendAnswer = vi.fn()
const ptyWrites: string[] = []

vi.mock('@/store', () => ({ useAppStore: { getState: () => state } }))
vi.mock('@/lib/agent-paste-draft', () => ({ getSettingsForAgentTabRuntimeOwner: () => ({}) }))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  sendRuntimePtyInput: (_settings: unknown, _pty: string, data: string) => ptyWrites.push(data)
}))
vi.mock('../../components/terminal-pane/terminal-screen-readers', () => ({
  readTerminalScreenReader: () => undefined
}))
vi.mock('../../components/native-chat/native-chat-interactive-answer', () => ({
  sendNativeChatInteractiveAnswer: (...args: unknown[]) => sendAnswer(...args)
}))

const { answerOmniosQuestion } = await import('./omnios-question-answer')

const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = `tab1:${LEAF}`
const PROMPT = JSON.stringify({
  questions: [
    {
      question: 'Depth?',
      header: 'Depth',
      multiSelect: false,
      options: [{ label: 'Quick' }, { label: 'Full' }]
    },
    { question: 'URLs?', header: 'URLs', multiSelect: false, options: [{ label: 'Prod' }] },
    {
      question: 'PR links?',
      header: 'PR links',
      multiSelect: true,
      options: [{ label: 'Open' }, { label: 'Merged' }, { label: 'Drafts' }]
    },
    { question: 'Stripe?', header: 'Stripe', multiSelect: false, options: [{ label: 'Yes' }] }
  ]
})

function blocked(prompt = PROMPT) {
  return {
    state: 'blocked',
    agentType: 'claude',
    toolName: 'AskUserQuestion',
    interactivePrompt: prompt,
    stateStartedAt: 100,
    terminalHandle: 'h1',
    connectionId: null
  }
}

function request(overrides: Partial<Parameters<typeof answerOmniosQuestion>[0]> = {}) {
  return {
    kind: 'answerOmniosQuestion' as const,
    paneKey: PANE,
    interactivePrompt: PROMPT,
    answers: {
      'Depth?': 'Full',
      'URLs?': 'https://example.com/a',
      'PR links?': 'Open, Drafts'
    },
    skipped: false,
    ...overrides
  }
}

beforeEach(() => {
  state.agentStatusByPaneKey = { [PANE]: blocked() }
  state.terminalLayoutsByTabId = { tab1: { ptyIdsByLeafId: { [LEAF]: 'pty1' } } }
  sendAnswer.mockReset()
  ptyWrites.length = 0
})
afterEach(() => vi.useRealTimers())

describe('answerOmniosQuestion', () => {
  it('sends every question through the card send and reports delivered only once it settles', async () => {
    let settle: (delivered: boolean) => void = () => {}
    sendAnswer.mockImplementation((_ctx, _prompt, _selections, onSettled) => {
      settle = onSettled
      return { settleAfterMs: 4000, waitsForVerifiedDelivery: true }
    })
    let reply: unknown = null
    const pending = answerOmniosQuestion(request()).then((value) => (reply = value))
    await Promise.resolve()
    expect(reply).toBeNull()
    const [ctx, prompt, selections] = sendAnswer.mock.calls[0]
    expect(ctx).toMatchObject({ terminalTabId: 'tab1', paneKey: PANE, targetPtyId: 'pty1' })
    expect(prompt.questions).toHaveLength(4)
    expect(selections).toEqual([
      { indices: [1] },
      { indices: [], other: 'https://example.com/a' },
      { indices: [0, 2] },
      { indices: [] }
    ])
    settle(true)
    await pending
    expect(reply).toEqual({ delivered: true })
  })

  it('reports the refusal when the pane does not confirm', async () => {
    sendAnswer.mockImplementation((_ctx, _prompt, _selections, onSettled) => {
      onSettled(false, 'partial')
      return { settleAfterMs: 0, waitsForVerifiedDelivery: true }
    })
    const reply = await answerOmniosQuestion(request())
    expect(reply).toMatchObject({ delivered: false, error: expect.stringMatching(/partly typed/) })
  })

  it('refuses without typing when the pane now asks something else', async () => {
    state.agentStatusByPaneKey = { [PANE]: blocked('{"questions":[]}') }
    const reply = await answerOmniosQuestion(request())
    expect(reply).toMatchObject({ delivered: false })
    expect(sendAnswer).not.toHaveBeenCalled()
    expect(ptyWrites).toEqual([])
  })

  it('refuses an answer that matches nothing', async () => {
    const reply = await answerOmniosQuestion(request({ answers: {} }))
    expect(reply).toMatchObject({ delivered: false, error: expect.stringMatching(/No answer/) })
    expect(sendAnswer).not.toHaveBeenCalled()
  })

  it('skips with Esc and reports delivered once the question leaves the pane', async () => {
    vi.useFakeTimers()
    const pending = answerOmniosQuestion(request({ skipped: true, answers: {} }))
    expect(ptyWrites).toEqual(['\x1b'])
    state.agentStatusByPaneKey = {
      [PANE]: { ...blocked(), state: 'working', interactivePrompt: null }
    }
    await vi.advanceTimersByTimeAsync(400)
    expect(await pending).toEqual({ delivered: true })
    expect(sendAnswer).not.toHaveBeenCalled()
  })

  it('does not report a skip delivered while the question stays open', async () => {
    vi.useFakeTimers()
    const pending = answerOmniosQuestion(request({ skipped: true, answers: {} }))
    await vi.advanceTimersByTimeAsync(7000)
    expect(await pending).toMatchObject({
      delivered: false,
      error: expect.stringMatching(/still open/)
    })
  })
})
