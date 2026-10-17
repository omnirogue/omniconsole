import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionLedgerReadResult } from '../../shared/session-ledger-read'
import { parseArgs } from '../args'
import { HANDLER_COMMAND_KEYS } from '../dispatch'
import type { RuntimeClient } from '../runtime-client'
import { COMMAND_SPECS } from '../specs'
import { SESSION_LEDGER_HANDLERS, formatSessionLedger } from './session-ledger'

const LISTED = Date.UTC(2026, 9, 6, 21, 0, 0)

function result(overrides: Partial<SessionLedgerReadResult> = {}): SessionLedgerReadResult {
  return {
    hostId: 'local',
    source: 'owner',
    generation: 'gen-1',
    revision: 12,
    ledgerSource: 'window',
    windowCurrent: true,
    listedAt: LISTED,
    coverage: [
      { worktreeId: 'repo::/a', complete: true },
      { worktreeId: 'repo::/b', complete: false }
    ],
    removals: 2,
    rows: [],
    counts: { ownerListed: 25, heldByOwner: 1, archived: 4 },
    receivers: [{ hostId: 'runtime:env-studio', savedAt: LISTED }],
    readAt: LISTED + 1_000,
    ...overrides
  }
}

async function run(argv: string[], answer: SessionLedgerReadResult = result(), isRemote = false) {
  const parsed = parseArgs(argv)
  const call = vi.fn(async () => ({ id: '1', ok: true as const, result: answer }))
  await SESSION_LEDGER_HANDLERS[parsed.commandPath.join(' ')]!({
    flags: parsed.flags,
    client: { call, isRemote } as unknown as RuntimeClient,
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
})

describe('omni session ledger (session parity, F19)', () => {
  it('is a registered command with a handler', () => {
    expect(COMMAND_SPECS.map((spec) => spec.path.join(' '))).toContain('session ledger')
    expect(HANDLER_COMMAND_KEYS.has('session ledger')).toBe(true)
  })

  it("reads this computer's own ledger by default and a paired owner's kept copy with --host", async () => {
    expect(await run(['session', 'ledger'])).toHaveBeenCalledWith('session.ledger', {})
    expect(await run(['session', 'ledger', '--host', 'local'])).toHaveBeenCalledWith(
      'session.ledger',
      {}
    )
    expect(
      await run(['session', 'ledger', '--host', 'runtime:550d5f62-153f-4a6f-ae56-8aba4fc6dd42'])
    ).toHaveBeenCalledWith('session.ledger', {
      host: 'runtime:550d5f62-153f-4a6f-ae56-8aba4fc6dd42'
    })
  })

  it('refuses an SSH host, an unknown host and another computer’s CLI before calling', async () => {
    await expect(run(['session', 'ledger', '--host', 'ssh:box'])).rejects.toThrow(
      'An SSH host has no conversation ledger'
    )
    await expect(run(['session', 'ledger', '--host', 'mw0002'])).rejects.toThrow('Use --host')
    await expect(run(['session', 'ledger'], result(), true)).rejects.toThrow(
      /computer running OmniConsole/
    )
  })

  it('says what it read: the live ledger, a kept copy as of its time, or none', () => {
    expect(formatSessionLedger(result()).split('\n')).toEqual([
      "This computer's ledger, as its paired computers receive it now (from its window)",
      'Generation gen-1, revision 12, window-authored, listed 2026-10-06T21:00:00.000Z',
      'Owner-listed: 25 · held by owner: 1 · archived: 4',
      'Workspaces: 2 (1 complete) · deletions kept: 2',
      'Kept from paired owners: runtime:env-studio'
    ])
    expect(
      formatSessionLedger(
        result({
          hostId: 'runtime:env-studio',
          source: 'receiver-snapshot',
          windowCurrent: undefined,
          receivers: undefined,
          asOf: LISTED - 60_000,
          savedAt: LISTED,
          removalsTruncated: true
        })
      ).split('\n')
    ).toEqual([
      "runtime:env-studio's ledger as this computer last reconciled it (as of 2026-10-06T20:59:00.000Z)",
      'Generation gen-1, revision 12, window-authored, listed 2026-10-06T21:00:00.000Z',
      'Owner-listed: 25 · held by owner: 1 · archived: 4',
      'Workspaces: 2 (1 complete) · deletions kept: 2 (cut: older ones missing)'
    ])
    expect(formatSessionLedger(result({ source: 'none' }))).toBe(
      'No conversation ledger yet: this computer has listed nothing since it started.'
    )
    expect(formatSessionLedger(result({ source: 'none', hostId: 'runtime:old' }))).toBe(
      'No ledger kept for runtime:old: it never sent one here (or runs an older OmniConsole).'
    )
  })
})
