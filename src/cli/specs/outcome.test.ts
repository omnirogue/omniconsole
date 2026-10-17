import { describe, expect, it, vi } from 'vitest'
import { COMMAND_SPECS } from './index'
import { parseArgs, validateCommandAndFlags } from '../args'
import { HANDLER_COMMAND_KEYS } from '../dispatch'
import { main } from '../index'

it('accepts both outcome commands and exposes their handlers', () => {
  for (const argv of [
    ['outcome', 'context', '--json'],
    ['outcome', 'audit'],
    ['outcome', 'audit', '--json'],
    ['outcome', 'attach', '--id', 'chain', '--task', 'btk_card1234'],
    [
      'outcome',
      'commit',
      '--body-file',
      '-',
      '--task',
      'btk_card1234',
      '--supersede',
      'New strategy'
    ],
    ['outcome', 'commit', '--body-file', '-', '--dispatch-capability', 'test-claim', '--json']
  ]) {
    const parsed = parseArgs(argv)
    expect(() => validateCommandAndFlags(COMMAND_SPECS, parsed)).not.toThrow()
    expect(HANDLER_COMMAND_KEYS.has(parsed.commandPath.join(' '))).toBe(true)
  }
})

describe('actual CLI agent discovery', () => {
  it('includes callable outcome context and inference instructions without a running app', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await main(['agent-context', '--json'])
      const schema = JSON.parse(log.mock.calls[0][0])
      const outcome = schema.commands.find(
        (entry: { command: string }) => entry.command === 'outcome context'
      )
      expect(outcome.flags).toContain('json')
      expect(outcome.notes.join('\n')).toContain('without requiring the user to open Next')
      expect(outcome.notes.join('\n')).toContain('Multiple outcomes do not authorize fan-out')
    } finally {
      log.mockRestore()
    }
  })
})

it('keeps the audit read-only: it takes no flag that could select or change a run', () => {
  const audit = COMMAND_SPECS.find((spec) => spec.path.join(' ') === 'outcome audit')!
  expect(audit.allowedFlags).toEqual([])
  expect(audit.destructive).toBeUndefined()
  expect(() =>
    validateCommandAndFlags(COMMAND_SPECS, parseArgs(['outcome', 'audit', '--id', 'chain']))
  ).toThrow()
})
