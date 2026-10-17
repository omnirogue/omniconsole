// @vitest-environment happy-dom
/**
 * `/next …` without the mouse.
 *
 * The acceptance is about what does NOT happen: the command line never reaches the
 * shell, and any other line reaches it byte for byte. Both are asserted here from
 * the same reader the pane installs, plus the chat composer's own use of it.
 */
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'
import {
  UP_NEXT_REASON_KEYS,
  UP_NEXT_REFUSAL_KEYS,
  UP_NEXT_RPC as PROMPT_QUEUE_RPC,
  type UpNextView
} from '../../../../shared/up-next-types'
import { upNextFixture } from '@/components/next-action/up-next-fixture'
import { parsePromptQueueCommand } from '../../../../shared/prompt-queue-command'
import { createPromptQueueTerminalInput } from './prompt-queue-terminal-input'
import { runPromptQueueCommand } from './prompt-queue-command-runner'
import { usePromptQueueCommand } from './use-prompt-queue-command'
import { UpNextChain } from '@/components/next-action/UpNextChain'
import { installTerminalAccessibleIdentity } from '@/components/terminal-pane/terminal-accessible-identity'

const source = { worktreeId: 'wt', paneKey: 'tab-1:leaf-1', kind: 'pty' as const }

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), source: vi.fn() }))

vi.mock('@/i18n/i18n', async () => {
  // Why the catalog and not only the fallback: a rule the HOST stated arrives as a key,
  // so no caller can pass its English literal — it has to read as its sentence here too.
  const catalog = (await import('@/i18n/locales/en.json')).default as Record<string, unknown>
  const said = (key: string): string | null => {
    let node: unknown = catalog
    for (const part of key.split('.')) {
      node = typeof node === 'object' && node ? (node as Record<string, unknown>)[part] : undefined
    }
    return typeof node === 'string' ? node : null
  }
  return {
    i18n: { language: 'en' },
    translate: (key: string, fallback: string, options?: Record<string, unknown>) =>
      (said(key) ?? fallback).replace(/{{(\w+)}}/g, (_match, name: string) =>
        String(options?.[name] ?? '')
      )
  }
})
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/lib/conversation-source-for-pane', () => ({
  conversationSourceForPane: mocks.source,
  upNextAddressForPane: () => {
    const source = mocks.source()
    return source ? { source, owner: { kind: 'local' } } : null
  }
}))

let view: UpNextView = upNextFixture()
beforeEach(() => {
  vi.clearAllMocks()
  view = { ...upNextFixture(), conversationId: source }
  mocks.source.mockReturnValue(source)
  mocks.rpc.mockImplementation(async (_target: unknown, method: string, params: unknown) => {
    if (method === PROMPT_QUEUE_RPC.append) {
      const { draft, position } = params as {
        draft: { text: string; when?: 'now' | 'after' }
        position: string
      }
      expect(position).toBe('head')
      view = {
        ...view,
        draftCount: 1,
        notation: '💬',
        blocks: [
          {
            id: 'e1',
            kind: 'prompt',
            state: 'draft',
            locked: false,
            number: '1',
            text: draft.text,
            target: { kind: 'current' },
            when: draft.when ?? 'after'
          }
        ]
      }
    }
    if (method === PROMPT_QUEUE_RPC.commit) {
      // The command queues the ONE block it just wrote, never everything composed.
      expect((params as { blockIds?: string[] }).blockIds).toEqual(['e1'])
      view = {
        ...view,
        draftCount: 0,
        queuedCount: 1,
        blocks: view.blocks.map((item) =>
          item.id === 'e1' ? { ...item, id: 'pq:e1', state: 'queued' } : item
        )
      }
    }
    if (method === PROMPT_QUEUE_RPC.remove) {
      const { blockId } = params as { blockId: string }
      view = { ...view, blocks: view.blocks.filter((item) => item.id !== blockId), notation: '' }
    }
    return { view }
  })
})
afterEach(cleanup)

type Pane = {
  type: (line: string) => boolean[]
  feed: (chunks: string[]) => boolean[]
  erased: string[]
  echoed: string[][]
}

function pane(options: { hasAgentSession?: boolean } = {}): Pane {
  const erased: string[] = []
  const echoed: string[][] = []
  const read = createPromptQueueTerminalInput({
    address: () => {
      const addressed = mocks.source() as typeof source | null
      return addressed ? { source: addressed, owner: { kind: 'local' } } : null
    },
    hasAgentSession: () => options.hasAgentSession !== false,
    erase: (data) => erased.push(data),
    echo: (lines) => echoed.push(lines)
  })
  const feed = (chunks: string[]): boolean[] => chunks.map((chunk) => read(chunk))
  return {
    // One call per chunk, exactly as xterm delivers keystrokes.
    type: (line) => feed([...Array.from(line), '\r']),
    feed,
    erased,
    echoed
  }
}

const enqueued = (): unknown[] =>
  mocks.rpc.mock.calls.filter((call) => call[1] === PROMPT_QUEUE_RPC.append).map((call) => call[2])

const committed = (): unknown[] =>
  mocks.rpc.mock.calls.filter((call) => call[1] === PROMPT_QUEUE_RPC.commit).map((call) => call[2])

describe('the grammar', () => {
  it.each([
    ['/next improve it', { kind: 'add', text: 'improve it' }],
    ['/queue add improve it', { kind: 'add', text: 'improve it' }],
    ['/next', { kind: 'list' }],
    ['/next   ', { kind: 'list' }],
    ['/queue', { kind: 'list' }],
    ['/queue list', { kind: 'list' }],
    ['/queue clear', { kind: 'clear' }]
  ])('reads %s', (line, expected) => {
    expect(parsePromptQueueCommand(line)).toEqual(expected)
  })

  it.each([
    'echo /next later',
    ' /next improve it',
    '/nextimprove',
    'git commit -m "/next"',
    '/queue something-else',
    'next improve it'
  ])('leaves %s alone', (line) => {
    expect(parsePromptQueueCommand(line)).toBeNull()
  })
})

describe('/next typed in a terminal pane', () => {
  it('swallows the Enter, takes the typed line back, and queues the text once', async () => {
    const terminal = pane()
    const line = '/next is there anything else we can do to improve?'

    const swallowed = terminal.type(line)

    // Every keystroke passed through; only the Enter was ours.
    expect(swallowed.slice(0, -1).every((handled) => handled === false)).toBe(true)
    expect(swallowed.at(-1)).toBe(true)
    expect(terminal.erased).toEqual(['\x7f'.repeat(line.length)])
    await waitFor(() => expect(enqueued()).toHaveLength(1))
    expect(enqueued()[0]).toMatchObject({
      conversationId: source,
      draft: { text: 'is there anything else we can do to improve?' }
    })
    // Typing it IS queueing it: one append, then one commit naming that block.
    await waitFor(() => expect(committed()).toHaveLength(1))
    expect(committed()[0]).toEqual({ conversationId: source, blockIds: ['e1'] })
    await waitFor(() => expect(terminal.echoed[0]?.[0]).toBe('💬'))
  })

  it('shows the strip the same queue the moment it is enqueued', async () => {
    const terminal = pane()
    terminal.type('/next improve it')
    await waitFor(() => expect(committed()).toHaveLength(1))

    render(<UpNextChain source={source} />)

    // A queued head prompt, with nothing left for the person to press.
    await waitFor(() => expect(screen.getByText('“improve it”')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Up to date' })).toBeTruthy()
    expect(screen.queryByText('not queued yet')).toBeNull()
  })

  it('leaves an ordinary line containing /next completely untouched', async () => {
    const terminal = pane()

    const swallowed = terminal.type('echo /next later')

    expect(swallowed.some((handled) => handled)).toBe(false)
    expect(terminal.erased).toEqual([])
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('gives up on a line the person edited with anything but backspace', async () => {
    const terminal = pane()

    // A left-arrow means the typed line is no longer knowable from the bytes, so
    // the reader forwards the Enter rather than guessing what the line says.
    const swallowed = terminal.feed(['/', 'n', 'e', 'x', 't', ' ', 'g', 'o', '\x1b[D', '\r'])

    expect(swallowed.every((handled) => handled === false)).toBe(true)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('reads a line the person corrected with backspace', async () => {
    const terminal = pane()

    terminal.feed(['/', 'n', 'e', 'x', 't', ' ', 'g', 'p', '\x7f', 'o', '\r'])

    await waitFor(() => expect(enqueued()).toHaveLength(1))
    expect(enqueued()[0]).toMatchObject({ draft: { text: 'go' } })
    expect(terminal.erased).toEqual(['\x7f'.repeat('/next go'.length)])
  })

  it('lists the queue locally on /queue, and never writes to the PTY', async () => {
    view = { ...upNextFixture('chain'), conversationId: source }
    const terminal = pane()

    expect(terminal.type('/queue').at(-1)).toBe(true)

    await waitFor(() => expect(terminal.echoed).toHaveLength(1))
    expect(terminal.echoed[0]).toEqual([view.notation])
    expect(mocks.rpc.mock.calls.every((call) => call[1] === PROMPT_QUEUE_RPC.list)).toBe(true)
    // The typed command was taken back, and nothing else was sent.
    expect(terminal.erased).toEqual(['\x7f'.repeat('/queue'.length)])
  })

  it('removes what is still waiting on /queue clear', async () => {
    view = { ...upNextFixture('chain'), conversationId: source }
    const terminal = pane()

    terminal.type('/queue clear')

    await waitFor(() => expect(terminal.echoed[0]).toEqual(['Nothing queued.']))
    expect(
      mocks.rpc.mock.calls
        .filter((call) => call[1] === PROMPT_QUEUE_RPC.remove)
        .map((call) => (call[2] as { blockId: string }).blockId)
    ).toEqual(['prompt', 'p2', 'p3'])
  })

  it('still queues in a plain shell, and says it waits for an agent', async () => {
    const terminal = pane({ hasAgentSession: false })

    terminal.type('/next improve it')

    await waitFor(() => expect(terminal.echoed[0]).toHaveLength(2))
    expect(terminal.echoed[0]).toEqual([
      '💬',
      'No agent is running here. Start one first, or the prompt is refused rather than typed into the shell.'
    ])
  })
})

describe('what /next reports back', () => {
  it('queues the prompt while the agent is busy, and says so', async () => {
    const report = await runPromptQueueCommand(source, { kind: 'add', text: 'improve it' })

    expect(committed()[0]).toEqual({ conversationId: source, blockIds: ['e1'] })
    expect(report).toEqual({
      lines: ['💬'],
      notice: 'Prompt queued; it goes to this agent as soon as it is free.',
      queued: true
    })
  })

  it('sends it into a free agent instead, and does not call that queued', async () => {
    view = { ...view, header: { state: 'idle' } }

    const report = await runPromptQueueCommand(source, { kind: 'add', text: 'improve it' })

    // `when: now` is the head-prompt "Send now" path: it is gone, not waiting.
    expect(enqueued()[0]).toMatchObject({ draft: { when: 'now' } })
    expect(committed()).toHaveLength(1)
    expect(report).toMatchObject({ notice: 'Prompt sent to the agent now.', queued: false })
  })

  it('never calls a refused prompt queued, and says the rule in words', async () => {
    mocks.rpc.mockRejectedValue(new Error(UP_NEXT_REFUSAL_KEYS.pastTerminal))

    const report = await runPromptQueueCommand(source, { kind: 'add', text: 'improve it' })

    expect(report.queued).toBe(false)
    expect(committed()).toHaveLength(0)
    expect(report.notice).toBe(report.lines[0])
    // The runner hands the host's rule to the catalog, which is where its sentence lives.
    expect(en.upNext.refusal.pastTerminal).toBe('Nothing can be placed after the end of the track.')
  })

  it('says a rule from the add-disabled catalog in words, not as its key', async () => {
    // The engine throws BOTH catalogs as the error's message; a pane used to print
    // `upNext.addDisabled.sessionClosed` at the person.
    mocks.rpc.mockRejectedValue(new Error(UP_NEXT_REASON_KEYS.sessionClosed))

    const report = await runPromptQueueCommand(source, { kind: 'add', text: 'improve it' })

    expect(report.lines).toEqual([en.upNext.addDisabled.sessionClosed])
    expect(report.notice).toBe(en.upNext.addDisabled.sessionClosed)
    expect(report.queued).toBe(false)
  })

  it('says a host sentence the engine threw without stating a catalog rule', async () => {
    // Live failure (evidence/na-live-phase1-20260918T043728Z/cli/20g): this sentence
    // arrived as the generic "could not be made on this host" banner in a terminal pane.
    const sentence =
      'This outcome has an in-flight or unverifiable action. Reconcile its receipt before editing.'
    mocks.rpc.mockRejectedValue(new Error(sentence))

    const report = await runPromptQueueCommand(source, { kind: 'add', text: 'improve it' })

    expect(report.lines).toEqual([sentence])
    expect(report.notice).toBe(sentence)
    expect(report.queued).toBe(false)
  })

  it('never lets a raw, unmapped catalog key leak into the pane as literal text', async () => {
    mocks.rpc.mockRejectedValue(
      new Error('upNext.refusal.someFutureRuleThisRendererDoesNotKnowYet')
    )

    const report = await runPromptQueueCommand(source, { kind: 'add', text: 'improve it' })

    expect(report.notice).toBe(en.upNext.writeUnavailable)
    expect(report.notice).not.toContain('upNext.')
  })
})

describe('/next typed in the chat composer', () => {
  it('queues instead of sending, and clears the draft', async () => {
    const setDraft = vi.fn()
    const report = vi.fn()
    const { result } = renderHook(() =>
      usePromptQueueCommand('tab-1:leaf-1', 'tab-1', setDraft, report)
    )

    // Nothing is read until a command is typed: the composer shares the terminal's runner
    // instead of holding a second Up next controller of its own.
    expect(mocks.rpc).not.toHaveBeenCalled()
    let handled = false
    await act(async () => {
      handled = result.current('/next improve it')
      await Promise.resolve()
    })

    expect(handled).toBe(true)
    expect(setDraft).toHaveBeenCalledWith('')
    await waitFor(() => expect(enqueued()).toHaveLength(1))
    expect(enqueued()[0]).toMatchObject({ conversationId: source, draft: { text: 'improve it' } })
    await waitFor(() => expect(committed()).toHaveLength(1))
    expect(committed()[0]).toEqual({ conversationId: source, blockIds: ['e1'] })
    await waitFor(() =>
      expect(report).toHaveBeenCalledWith(
        'Prompt queued; it goes to this agent as soon as it is free.'
      )
    )
  })

  it('sends an ordinary message the ordinary way', async () => {
    const { result } = renderHook(() =>
      usePromptQueueCommand('tab-1:leaf-1', 'tab-1', vi.fn(), vi.fn())
    )

    expect(result.current('Have you done your best job?')).toBe(false)
    expect(enqueued()).toHaveLength(0)
  })
})

describe('how the Enter reaches the reader', () => {
  it('reads the line xterm reported a focus change in the middle of', async () => {
    const terminal = pane()

    // Live failure LS-1: revealing/clicking a pane focuses xterm, and an agent CLI with
    // focus reporting on (`\e[?1004h`) makes xterm put its focus report on this same
    // stream. It is not the person's line, so the line stays readable.
    const swallowed = terminal.feed([
      '\x1b[I',
      ...Array.from('/next go'),
      '\x1b[<0;10;5M',
      '\x1b[O',
      '\r'
    ])

    expect(swallowed.at(-1)).toBe(true)
    expect(terminal.erased).toEqual(['\x7f'.repeat('/next go'.length)])
    await waitFor(() => expect(enqueued()).toHaveLength(1))
    expect(enqueued()[0]).toMatchObject({ draft: { text: 'go' } })
  })

  it('reads the line when Enter arrives as the kitty keyboard encoding', async () => {
    const terminal = pane()

    const swallowed = terminal.feed([...Array.from('/next go'), '\x1b[13u'])

    expect(swallowed.at(-1)).toBe(true)
    await waitFor(() => expect(committed()).toHaveLength(1))
  })

  it('reads a whole command line written in one go, and takes nothing back', async () => {
    const terminal = pane()

    // The accessible "Terminal input" delivers the line and its Enter as one write.
    const swallowed = terminal.feed(['/next go\r'])

    expect(swallowed).toEqual([true])
    // Those characters never reached the agent, so there is nothing to erase.
    expect(terminal.erased).toEqual([])
    await waitFor(() => expect(enqueued()).toHaveLength(1))
    expect(enqueued()[0]).toMatchObject({ draft: { text: 'go' } })
  })

  it('leaves an ordinary line written in one go alone', async () => {
    const terminal = pane()

    expect(terminal.feed(['echo hi\r'])).toEqual([false])
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('still refuses to guess a line edited with anything but backspace', async () => {
    const terminal = pane()

    // The ignored focus report must not revive a line the reader already gave up on.
    const swallowed = terminal.feed(['/next go', '\x1b[D', '\x1b[I', '\r'])

    expect(swallowed.every((handled) => handled === false)).toBe(true)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
})

describe('/next delivered through the accessible Terminal input', () => {
  it('reaches the one runner and never the PTY', async () => {
    const written: string[] = []
    const erased: string[] = []
    const read = createPromptQueueTerminalInput({
      address: () => {
        const addressed = mocks.source() as typeof source | null
        return addressed ? { source: addressed, owner: { kind: 'local' } } : null
      },
      hasAgentSession: () => true,
      erase: (data) => erased.push(data),
      echo: () => {}
    })
    const textarea = document.createElement('textarea')
    document.body.append(textarea)
    // The pane's own door: xterm.input() is what the accessible action calls, and the
    // reader sits on the data it produces.
    const host = {
      textarea,
      focus: () => textarea.focus(),
      input: (data: string) => {
        if (!read(data)) {
          written.push(data)
        }
      }
    }
    const binding = installTerminalAccessibleIdentity(host, source.paneKey)

    const event = new CustomEvent('omni-terminal-accessible-action', {
      detail: { paneKey: source.paneKey, value: '/next go\r' },
      cancelable: true
    })
    textarea.dispatchEvent(event)

    await waitFor(() => expect(enqueued()).toHaveLength(1))
    expect(enqueued()[0]).toMatchObject({ conversationId: source, draft: { text: 'go' } })
    await waitFor(() => expect(committed()).toHaveLength(1))
    // Nothing of the command reached the shell, and nothing had to be taken back.
    expect(written).toEqual([])
    expect(erased).toEqual([])
    binding.dispose()
    textarea.remove()
  })
})
