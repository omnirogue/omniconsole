import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../args'
import type { RuntimeClient } from '../runtime-client'
import { SESSION_MANAGE_HANDLERS } from './session-manage'
import { SESSION_REUSE_HANDLERS } from './session-reuse'
import { formatSessionWhenIdle } from '../session-reuse-format'

const ORIGINAL_EXIT_CODE = process.exitCode
const REF = 'claude:2f0c9f4e-8d1a-4c7e-9b8e-0e6f3f2a1b7c@local'

async function run(argv: string[], result: unknown = { summary: 'done', dryRun: false }) {
  const parsed = parseArgs(argv)
  const key = parsed.commandPath.join(' ')
  const handler = SESSION_REUSE_HANDLERS[key] ?? SESSION_MANAGE_HANDLERS[key]!
  const call = vi.fn(async (_method: string, _params?: unknown, _options?: unknown) => ({ result }))
  await handler({
    flags: parsed.flags,
    client: { call, isRemote: false } as unknown as RuntimeClient,
    cwd: '/tmp',
    json: true
  })
  return call
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = ORIGINAL_EXIT_CODE
})

describe('omni session resume', () => {
  it('sends the ref with its provenance and waits long enough for the agent to confirm', async () => {
    const call = await run([
      'session',
      'resume',
      '--ref',
      REF,
      '--reason',
      'continue the parser',
      '--dry-run'
    ])
    expect(call).toHaveBeenCalledWith(
      'sessionManage.resume',
      { ref: REF, reason: 'continue the parser', dryRun: true },
      { timeoutMs: 180_000 }
    )
  })
})

describe('omni session continue --when-idle', () => {
  it('holds a prompt through its own method, with the window and --wait', async () => {
    const call = await run([
      'session',
      'continue',
      '--pane',
      'tab-2:leaf-2',
      '--prompt',
      'Also cover the export path',
      '--when-idle',
      '--within',
      '45m',
      '--wait',
      '--reason',
      'same files'
    ])
    expect(call).toHaveBeenCalledWith(
      'sessionManage.continueWhenIdle',
      {
        target: { paneKey: 'tab-2:leaf-2' },
        text: 'Also cover the export path',
        withinMs: 45 * 60_000,
        wait: true,
        reason: 'same files'
      },
      { timeoutMs: 45 * 60_000 + 60_000 }
    )
    expect(call.mock.calls.some(([method]) => method === 'sessionManage.continue')).toBe(false)
  })

  it('exits non-zero when a waited prompt ended unsent', async () => {
    await run(['session', 'continue', '--pane', 'p', '--prompt', 'x', '--when-idle', '--wait'], {
      summary: 'not free',
      dryRun: false,
      pending: { state: 'expired' }
    })
    expect(process.exitCode).toBe(1)
  })

  it.each([
    [['--yes', '--when-idle'], '--when-idle holds a --prompt'],
    [['--prompt', 'x', '--within', '30m'], '--within and --wait go with --when-idle'],
    [['--prompt', 'x', '--when-idle', '--within', '9h'], 'from 1m to 4h']
  ])('refuses %j before calling anything', async (extra, words) => {
    await expect(run(['session', 'continue', '--pane', 'p', ...extra])).rejects.toThrow(words)
  })

  it('prints the held prompt with how long it waits', () => {
    const text = formatSessionWhenIdle({
      dryRun: false,
      action: 'continue',
      target: { paneKey: 'tab-2:leaf-2', title: 'Parser fix' },
      actor: { kind: 'cli' },
      summary: 'Holding a prompt from omni CLI for “Parser fix”.',
      pending: {
        id: 'held-1',
        createdAt: Date.UTC(2026, 8, 25, 12),
        expiresAt: Date.UTC(2026, 8, 25, 12, 30),
        actor: { kind: 'cli' },
        target: { paneKey: 'tab-2:leaf-2', tabId: 'tab-2', title: 'Parser fix' },
        text: 'Also cover the export path',
        state: 'waiting',
        note: 'Waiting: it is working.'
      }
    })
    expect(text).toContain('waiting · “Parser fix” · pane tab-2:leaf-2 · held-1')
    expect(text).toContain('held 2026-09-25 12:00 until 2026-09-25 12:30')
    expect(text).toContain('Waiting: it is working.')
  })
})

describe('omni session pending', () => {
  it('lists or cancels held prompts', async () => {
    const list = await run(['session', 'pending', '--all'], { deliveries: [] })
    expect(list).toHaveBeenCalledWith('sessionManage.pending', { all: true })
    const cancel = await run(['session', 'pending', '--cancel', 'held-1'], { deliveries: [] })
    expect(cancel).toHaveBeenCalledWith('sessionManage.pending', { cancel: 'held-1' })
  })
})
