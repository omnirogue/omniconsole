import { describe, expect, it, vi } from 'vitest'
import { requireExpectedPrompt } from './session-manage-answer'
import { manageEntry, sidebarRow } from './session-manage-test-fixtures'
import { readRuntimeSessionPrompt, type SessionPromptRuntime } from './session-prompt-runtime'

vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => null
}))

const screen = 'Bash command\n  pwd\nDo you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel'
const questionHook = JSON.stringify({
  questions: [
    {
      question: 'Which parser?',
      options: [
        { label: 'Existing parser', description: 'Keep current behavior' },
        { label: 'A new parser' }
      ]
    }
  ]
})

function runtime(source = 'screen', interactivePrompt: string | null = null) {
  return {
    resolveTerminalPane: vi.fn(() => ({ handle: 'term_1', ptyId: 'pty-1', connected: true })),
    readTerminal: vi.fn(async () => ({ source, tail: screen.split('\n') })),
    getFreshAgentHookStatusForHandle: vi.fn(() => ({ state: 'blocked', interactivePrompt }))
  } as unknown as SessionPromptRuntime
}

describe('runtime prompt evidence', () => {
  it('reads only the current rendered screen for PTY delivery', async () => {
    const rt = runtime()
    const prompt = await readRuntimeSessionPrompt(rt, sidebarRow(), 'term_1')
    expect(rt.readTerminal).toHaveBeenCalledExactlyOnceWith('term_1', { screen: true, limit: 2000 })
    expect(prompt?.delivery).toMatchObject({
      kind: 'pty',
      handle: 'term_1',
      ptyId: 'pty-1',
      screen
    })
  })

  it.each(['stream', 'screen-unavailable'])(
    'never treats a %s tail as a current prompt',
    async (source) => {
      expect(await readRuntimeSessionPrompt(runtime(source), sidebarRow(), 'term_1')).toBeNull()
    }
  )

  it('shows full question hooks for discovery without granting a terminal delivery path', async () => {
    const prompt = (await readRuntimeSessionPrompt(
      runtime('screen-unavailable', questionHook),
      sidebarRow(),
      'term_1'
    ))!
    expect(prompt.ask).toMatchObject({
      kind: 'question',
      text: 'Which parser?',
      options: [
        { n: 1, label: 'Existing parser\nKeep current behavior' },
        { n: 2, label: 'A new parser' }
      ]
    })
    expect(() =>
      requireExpectedPrompt(
        {
          entry: manageEntry({ state: 'awaiting-user' }),
          source: { kind: 'pty', paneKey: 'target', worktreeId: 'folder' },
          prompt
        },
        { kind: 'cli' },
        prompt.ask.fingerprint
      )
    ).toThrow('layout cannot be verified')
  })

  it('does not invent approval options from a hook summary without a matching screen', async () => {
    const hook = JSON.stringify({ approval: { tool: 'Bash', summary: 'pwd' } })
    expect(
      await readRuntimeSessionPrompt(runtime('screen-unavailable', hook), sidebarRow(), 'term_1')
    ).toBeNull()
  })

  it('does not reuse a replacement handle or an absent structured host', async () => {
    expect(await readRuntimeSessionPrompt(runtime(), sidebarRow(), 'term_replaced')).toBeNull()
    expect(
      await readRuntimeSessionPrompt(
        runtime(),
        sidebarRow({ kind: 'structured', structuredSessionId: 'chat-session' }),
        null
      )
    ).toBeNull()
  })
})
