import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClient } from '../runtime-client'
import { TERMINAL_HANDLERS } from './terminal'
import { parseArgs } from '../args'

const row = {
  v: 1,
  ts: '2026-10-03T12:00:00.000Z',
  pipeline: 'renderer-ipc',
  ptyId: 'pty-1',
  cause: 'automation',
  reference: {
    automationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    automationRunId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  },
  actor: { kind: 'renderer' },
  hasStartupCommand: true,
  process: 'created'
}
const why = {
  terminal: 'term_55555555-5555-4555-8555-555555555555',
  ptyId: 'pty-1',
  paneKey: null,
  launch: row
}
afterEach(() => vi.restoreAllMocks())
async function invoke(json: boolean, launch: unknown = row) {
  const handler = TERMINAL_HANDLERS['terminal why']
  expect(typeof handler, 'terminal why must be registered').toBe('function')
  const call = vi.fn().mockResolvedValue({ result: { why: { ...why, launch } } })
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  const parsed = parseArgs([
    'terminal',
    'why',
    '--terminal',
    'term_55555555-5555-4555-8555-555555555555',
    ...(json ? ['--json'] : [])
  ])
  await handler({
    flags: parsed.flags,
    client: { call } as unknown as RuntimeClient,
    cwd: '/tmp/worktree',
    json
  })
  expect(call).toHaveBeenCalledWith('terminal.why', {
    terminal: 'term_55555555-5555-4555-8555-555555555555'
  })
  return log.mock.calls.map(([text]) => String(text)).join('\n')
}
describe('terminal why CLI', () => {
  it('prints a short routine explanation with actor, time and owner ids', async () => {
    const text = await invoke(false)
    expect(text).toMatch(/routine|automation/i)
    expect(text).toMatch(/renderer/i)
    expect(text).toContain('2026-10-03')
    expect(text).toContain('12:00')
    expect(text).toContain('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    expect(text).toContain('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
    expect(text.split(/(?<=[.!?])\s+/).filter(Boolean).length).toBeLessThanOrEqual(2)
  })
  it('returns the exact why payload for --json', async () => {
    expect(JSON.parse(await invoke(true))).toEqual({ result: { why } })
  })
  it('prints the plain no launch record line', async () => {
    expect(await invoke(false, null)).toMatch(/^No launch record for this terminal[^\n]*$/)
  })
})
