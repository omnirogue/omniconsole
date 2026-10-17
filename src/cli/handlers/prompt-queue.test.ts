/**
 * `omni prompt-queue …` — a reader, and a plain sentence where it cannot write.
 *
 * Measured live on build f6fe7704c1: the host refused add, clear AND list from the
 * CLI with `This decision requires the authenticated user interface, not an agent
 * assertion.` These tests pin the two answers to that: `list` now goes through
 * (the host side is pinned in `rpc/methods/prompt-queue.test.ts`), and a write says
 * what to do instead without sending anything.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch'
import { PROMPT_QUEUE_RPC, type PromptQueue } from '../../shared/prompt-queue-types'
import { COMMAND_SPECS } from '../specs'
import { normalizeCommandPositionals, parseArgs, validateCommandAndFlags } from '../args'
import { ROOT_HELP_TEXT_PRIMARY } from '../root-help-text-primary'
import { PROMPT_QUEUE_CLI_WRITE_REFUSAL, PROMPT_QUEUE_HANDLERS } from './prompt-queue'

const source = { worktreeId: 'folder', paneKey: 'tab-1:leaf-1', kind: 'pty' }

const queue = (...texts: string[]): PromptQueue =>
  ({
    source,
    entries: texts.map((text, index) => ({
      id: `e${index + 1}`,
      text,
      createdAt: index,
      state: 'queued'
    }))
  }) as PromptQueue

function setup(initial: PromptQueue) {
  const call = vi.fn(async () => ({ id: 'rpc', ok: true, result: { queue: initial } }))
  return { call }
}

/** The real argv path, so the flags and positionals are parsed as a shell passes them. */
function run(argv: string[], call: ReturnType<typeof setup>['call'], json = false) {
  const parsed = normalizeCommandPositionals(
    COMMAND_SPECS,
    parseArgs(
      argv,
      COMMAND_SPECS.map((spec) => spec.path)
    )
  )
  validateCommandAndFlags(COMMAND_SPECS, parsed)
  const handler = PROMPT_QUEUE_HANDLERS[parsed.commandPath.join(' ')]!
  return handler({
    client: { call },
    flags: parsed.flags,
    cwd: '/work',
    json
  } as unknown as HandlerContext)
}

beforeEach(() => {
  vi.stubEnv('ORCA_PANE_KEY', 'tab-1:leaf-1')
  vi.stubEnv('ORCA_WORKTREE_ID', 'folder')
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('omni prompt-queue list', () => {
  it('reads the queue of the pane it was run in, with no flags', async () => {
    const host = setup(queue('Plan', 'Build'))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await run(['prompt-queue', 'list'], host.call)

    expect(host.call).toHaveBeenCalledWith(PROMPT_QUEUE_RPC.list, { source })
    expect(log.mock.calls[0]?.[0]).toBe('Queued 2\n1. queued · Plan\n2. queued · Build')
  })

  it('reads another conversation with --pane and --worktree', async () => {
    const host = setup(queue())

    await run(['prompt-queue', 'list', '--pane', 'tab-9:leaf-9', '--worktree', 'other'], host.call)

    expect(host.call).toHaveBeenCalledWith(PROMPT_QUEUE_RPC.list, {
      source: { worktreeId: 'other', paneKey: 'tab-9:leaf-9', kind: 'pty' }
    })
  })

  it('says so when nothing is queued', async () => {
    const host = setup(queue())
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await run(['prompt-queue', 'list'], host.call)

    expect(log.mock.calls[0]?.[0]).toBe('Nothing is queued for this conversation.')
  })

  it('refuses when no pane can be named at all', async () => {
    // Emptied rather than unstubbed: the process running this test may itself be
    // inside an OmniConsole pane, and that pane is not this test's address.
    vi.stubEnv('ORCA_PANE_KEY', '')
    vi.stubEnv('ORCA_WORKTREE_ID', '')
    const host = setup(queue())

    await expect(run(['prompt-queue', 'list'], host.call)).rejects.toThrow('--pane')
    expect(host.call).not.toHaveBeenCalled()
  })
})

describe('omni prompt-queue add / clear', () => {
  it('answers a queue attempt with what to type instead, and sends nothing', async () => {
    const host = setup(queue())

    await expect(
      run(['prompt-queue', 'add', 'is there anything else we can do to improve?'], host.call)
    ).rejects.toThrow('Queueing needs the app: type /next <prompt> in this terminal.')
    expect(host.call).not.toHaveBeenCalled()
  })

  it('never relays the host authority error to the person', async () => {
    const host = setup(queue())

    const refusal = await run(['prompt-queue', 'add', 'go'], host.call).then(
      () => null,
      (cause: unknown) => (cause as Error).message
    )

    expect(refusal).toBe(PROMPT_QUEUE_CLI_WRITE_REFUSAL)
    expect(refusal).not.toMatch(/agent assertion/)
  })

  it('answers a clear attempt the same way, and sends nothing', async () => {
    const host = setup(queue('Plan'))

    await expect(run(['prompt-queue', 'clear'], host.call)).rejects.toThrow('needs the app')
    expect(host.call).not.toHaveBeenCalled()
  })
})

describe('discoverability', () => {
  it('lists prompt-queue in the top-level help', () => {
    const help = ROOT_HELP_TEXT_PRIMARY
    expect(help).toContain('prompt-queue list')
    expect(help).toContain('prompt-queue add')
    expect(help).toContain('prompt-queue clear')
  })

  it('tells the truth in every spec it ships', () => {
    const specs = COMMAND_SPECS.filter((spec) => spec.path[0] === 'prompt-queue')
    expect(specs.map((spec) => spec.path.join(' '))).toEqual([
      'prompt-queue list',
      'prompt-queue add',
      'prompt-queue clear'
    ])
    for (const spec of specs.filter((candidate) => candidate.path[1] !== 'list')) {
      expect(spec.summary).toMatch(/Not available from the CLI/)
    }
  })
})
