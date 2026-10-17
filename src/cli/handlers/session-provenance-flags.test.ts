import { describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../args'
import type { RuntimeClient } from '../runtime-client'
import { SESSION_MANAGE_HANDLERS } from './session-manage'
import { sessionProvenance } from './session-provenance-flags'

describe('session dry-run provenance', () => {
  it.each(['true', 'false', '1', '0', ''])(
    'refuses an assigned dry-run value %j before RPC',
    async (value) => {
      const { flags } = parseArgs([
        'session',
        'continue',
        '--pane',
        'p',
        '--yes',
        `--dry-run=${value}`
      ])
      const call = vi.fn()
      await expect(
        SESSION_MANAGE_HANDLERS['session continue']!({
          flags,
          client: { call, isRemote: false } as unknown as RuntimeClient,
          cwd: '/tmp',
          json: true
        })
      ).rejects.toThrow('Pass --dry-run without a value')
      expect(call).not.toHaveBeenCalled()
    }
  )

  it('preserves bare dry-run and does not add it when absent', () => {
    expect(sessionProvenance(parseArgs(['--dry-run']).flags)).toEqual({ dryRun: true })
    expect(sessionProvenance(parseArgs([]).flags)).toEqual({})
  })
})
