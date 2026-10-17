import { describe, expect, it } from 'vitest'
import { consoleWorkflowAcceptanceCommands } from './console-workflow-acceptance'

const command = {
  program: 'node',
  args: ['', 'a b', '"quoted"', '$literal', 'C:\\work\\test.js'],
  timeout_ms: 60_000
}

describe('frozen workflow acceptance argv', () => {
  it('preserves literal arguments and an explicitly empty command list', () => {
    expect(consoleWorkflowAcceptanceCommands.parse([command])).toEqual([command])
    expect(consoleWorkflowAcceptanceCommands.parse([])).toEqual([])
  })
  it('refuses shell/environment fields, control characters and out-of-contract limits', () => {
    for (const value of [
      [{ ...command, shell: true }],
      [{ ...command, env: { TOKEN: 'not-a-secret' } }],
      [{ ...command, program: '   ' }],
      [{ ...command, args: ['line\nline'] }],
      [{ ...command, args: ['nul\0value'] }],
      [{ ...command, timeout_ms: 0 }],
      [{ ...command, timeout_ms: 3_600_001 }],
      [{ ...command, timeout_ms: 1.5 }],
      [{ ...command, args: Array(129).fill('x') }],
      Array.from({ length: 33 }, () => ({ ...command })),
      [{ ...command, args: Array(20).fill('x'.repeat(4096)) }]
    ]) {
      expect(consoleWorkflowAcceptanceCommands.safeParse(value).success).toBe(false)
    }
  })
})
