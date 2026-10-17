import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../args'
import { RuntimeClientError, type RuntimeClient } from '../runtime-client'
import type * as ExecutionHostFlagModule from '../execution-host-flag'
import { SESSION_TRANSFER_HANDLERS } from './session-transfer'

// The connected runtime resolves an SSH label to its registered target id.
vi.mock('../execution-host-flag', async (importOriginal) => ({
  ...(await importOriginal<typeof ExecutionHostFlagModule>()),
  resolveHostFlagTarget: vi.fn(async () => ({
    kind: 'ssh',
    id: 'ssh:ssh-1790288125545',
    targetId: 'ssh-1790288125545'
  }))
}))

const exitCode = process.exitCode

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = exitCode
})

async function run(argv: string[], outcome = 'completed') {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const call = vi.fn(async () => ({ result: { outcome, summary: 'done', dryRun: false } }))
  const parsed = parseArgs(argv)
  await SESSION_TRANSFER_HANDLERS[parsed.commandPath.join(' ')]({
    flags: parsed.flags,
    client: { call, isRemote: false } as unknown as RuntimeClient,
    json: true,
    cwd: '/tmp'
  })
  return call
}

describe('session transfer CLI', () => {
  it('passes handoff target, note and provenance and waits for both turns', async () => {
    const call = await run([
      'session',
      'handoff',
      '--pane',
      'source',
      '--to',
      'new',
      '--note',
      'Next step',
      '--reason',
      'context full',
      '--request',
      'carry this over',
      '--dry-run'
    ])
    expect(call).toHaveBeenCalledWith(
      'sessionManage.handoff',
      {
        target: { paneKey: 'source' },
        to: 'new',
        note: 'Next step',
        reason: 'context full',
        request: 'carry this over',
        dryRun: true
      },
      { timeoutMs: 720_000 }
    )
  })

  it('parses skip-busy as a boolean and budgets a wait for every source plus acknowledgement', async () => {
    const call = await run([
      'session',
      'consolidate',
      '--panes',
      'a,b,c',
      '--into',
      'target',
      '--skip-busy'
    ])
    expect(call).toHaveBeenCalledWith(
      'sessionManage.consolidate',
      {
        panes: ['a', 'b', 'c'],
        into: 'target',
        skipBusy: true
      },
      { timeoutMs: 1_320_000 }
    )
  })

  it('requires an explicit source and distinct consolidation panes', async () => {
    await expect(run(['session', 'handoff', '--to', 'new'])).rejects.toThrow('Name the session')
    await expect(
      run(['session', 'consolidate', '--panes', 'a,a', '--into', 'new'])
    ).rejects.toThrow('distinct')
  })

  it('returns nonzero after a reported failed step', async () => {
    await run(['session', 'handoff', '--pane', 'source', '--to', 'new'], 'failed')
    expect(process.exitCode).toBe(1)
  })
  it('reports a lost transport reply as uncertain and never replays a transfer', async () => {
    const call = vi.fn().mockRejectedValue(new RuntimeClientError('runtime_timeout', 'Timed out'))
    const parsed = parseArgs(['session', 'handoff', '--pane', 'source', '--to', 'new'])
    await expect(
      SESSION_TRANSFER_HANDLERS['session handoff']({
        flags: parsed.flags,
        client: { call, isRemote: false } as unknown as RuntimeClient,
        json: true,
        cwd: '/tmp'
      })
    ).rejects.toMatchObject({
      code: 'runtime_timeout',
      message: expect.stringContaining('Transfer outcome is unknown'),
      data: { outcome: 'unknown', method: 'sessionManage.handoff' }
    })
    expect(call).toHaveBeenCalledOnce()
  })

  describe('moving to another computer', () => {
    it('sends the resolved SSH host and workspace, with a longer budget for the move', async () => {
      const call = await run([
        'session',
        'handoff',
        '--pane',
        'source',
        '--to',
        'new',
        '--host',
        'ssh:mw0002',
        '--workspace',
        'id:host-repo::/work/parser',
        '--dry-run'
      ])
      expect(call).toHaveBeenCalledExactlyOnceWith(
        'sessionManage.handoff',
        {
          target: { paneKey: 'source' },
          to: 'new',
          host: 'ssh:ssh-1790288125545',
          workspace: 'id:host-repo::/work/parser',
          dryRun: true
        },
        { timeoutMs: 1_320_000 }
      )
    })

    it('refuses a paired OmniConsole host, a named target and a stray --workspace unsent', async () => {
      const cases: [string[], string][] = [
        [['--to', 'new', '--host', 'runtime:env-1'], 'paired OmniConsole'],
        [['--to', 'tab-2:leaf-2', '--host', 'ssh:mw0002'], 'use new as the target'],
        [['--to', 'new', '--host', 'local'], '--host local is this computer'],
        [['--to', 'new', '--workspace', 'id:w'], 'pass --host ssh:<id> too']
      ]
      for (const [flags, message] of cases) {
        const call = vi.fn()
        const parsed = parseArgs(['session', 'handoff', '--pane', 'source', ...flags])
        await expect(
          SESSION_TRANSFER_HANDLERS['session handoff']({
            flags: parsed.flags,
            // A paired host already rerouted the client; it must not be used.
            client: { call, isRemote: true } as unknown as RuntimeClient,
            json: true,
            cwd: '/tmp'
          })
        ).rejects.toThrow(message)
        expect(call).not.toHaveBeenCalled()
      }
    })

    it('names an older OmniConsole that cannot move work instead of a schema error', async () => {
      const call = vi
        .fn()
        .mockRejectedValue(
          new RuntimeClientError('invalid_argument', "Unrecognized key(s) in object: 'host'")
        )
      const parsed = parseArgs([
        'session',
        'consolidate',
        '--panes',
        'a,b',
        '--into',
        'new',
        '--host',
        'ssh:mw0002'
      ])
      await expect(
        SESSION_TRANSFER_HANDLERS['session consolidate']({
          flags: parsed.flags,
          client: { call, isRemote: false } as unknown as RuntimeClient,
          json: true,
          cwd: '/tmp'
        })
      ).rejects.toMatchObject({
        code: 'incompatible_runtime',
        message: expect.stringContaining('predates moving work to another computer')
      })
    })
  })
})
