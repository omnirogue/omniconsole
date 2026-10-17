import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrcaRuntimeService } from '../../omni-runtime'
import { RpcDispatcher } from '../dispatcher'
import { TERMINAL_METHODS } from './terminal'
import { makeStore } from '../../runtime-rpc-worktree-store-fixtures'
import {
  _resetLaunchLedgerForTests,
  LAUNCH_LEDGER_FILE,
  setLaunchLedgerDirectory
} from '../../../launch-ledger/launch-ledger'

let directory: string
let runtime: OrcaRuntimeService
let dispatcher: RpcDispatcher
let handle: string
const row = {
  v: 1,
  ts: '2026-10-03T12:00:00.000Z',
  pipeline: 'renderer-ipc',
  ptyId: 'pty-1',
  paneKey: '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
  cause: 'automation',
  reference: {
    automationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    automationRunId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  },
  actor: { kind: 'renderer' },
  hasStartupCommand: true,
  process: 'created'
}
function request(method: string, terminal = handle) {
  return { id: 'req-1', authToken: 'token', method, params: { terminal } }
}
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'terminal-why-red-'))
  await setLaunchLedgerDirectory(directory)
  runtime = new OrcaRuntimeService(makeStore() as never)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: '11111111-1111-4111-8111-111111111111',
        worktreeId: 'repo-1::/tmp/worktree-a',
        title: 'Claude',
        activeLeafId: '22222222-2222-4222-8222-222222222222',
        layout: null
      }
    ],
    leaves: [
      {
        tabId: '11111111-1111-4111-8111-111111111111',
        worktreeId: 'repo-1::/tmp/worktree-a',
        leafId: '22222222-2222-4222-8222-222222222222',
        paneRuntimeId: 1,
        ptyId: 'pty-1'
      }
    ]
  })
  handle = runtime.resolveTerminalPane(
    '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222'
  )!.handle
  dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
})
afterEach(async () => {
  await _resetLaunchLedgerForTests()
  rmSync(directory, { recursive: true, force: true })
})
describe('terminal.why RPC', () => {
  it('returns the exact durable launch row for a known terminal', async () => {
    writeFileSync(join(directory, LAUNCH_LEDGER_FILE), `${JSON.stringify(row)}\n`)
    const response = await dispatcher.dispatch(request('terminal.why'))
    expect({ ok: response.ok, result: response.ok ? response.result : undefined }).toEqual({
      ok: true,
      result: {
        why: {
          terminal: handle,
          ptyId: 'pty-1',
          paneKey: '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
          launch: row
        }
      }
    })
  })
  it('returns creation before a later unfinished attachment', async () => {
    const attachment = {
      ...row,
      ts: '2026-10-03T13:00:00.000Z',
      process: 'attachment-intent',
      intent: 'attach',
      cause: 'cli',
      reference: undefined
    }
    writeFileSync(
      join(directory, LAUNCH_LEDGER_FILE),
      `${JSON.stringify(row)}\n${JSON.stringify(attachment)}\n`
    )
    const response = await dispatcher.dispatch(request('terminal.why'))
    expect(response.ok ? response.result : response.error).toEqual({
      why: {
        terminal: handle,
        ptyId: 'pty-1',
        paneKey: row.paneKey,
        launch: row,
        attachments: [
          Object.fromEntries(Object.entries(attachment).filter(([, value]) => value !== undefined))
        ]
      }
    })
  })
  it('uses the execution host current incarnation and separates older creation history', async () => {
    const incarnationId = '33333333-3333-4333-8333-333333333333'
    runtime.registerPty('pty-1', 'repo-1::/tmp/worktree-a', null, {
      tabId: row.paneKey.split(':')[0],
      leafId: row.paneKey.split(':')[1],
      incarnationId
    })
    const previous = { ...row, incarnationId: '22222222-2222-4222-8222-222222222222' }
    const attached = {
      ...row,
      incarnationId,
      process: 'attached',
      cause: 'cli',
      reference: undefined
    }
    writeFileSync(
      join(directory, LAUNCH_LEDGER_FILE),
      `${JSON.stringify(previous)}\n${JSON.stringify(attached)}\n`
    )
    const response = await dispatcher.dispatch(request('terminal.why'))
    expect(response.ok ? response.result : response.error).toEqual({
      why: {
        terminal: handle,
        ptyId: 'pty-1',
        paneKey: row.paneKey,
        launch: null,
        currentStartUnrecorded: true,
        previousCreations: [previous],
        attachments: [
          Object.fromEntries(Object.entries(attached).filter(([, value]) => value !== undefined))
        ]
      }
    })
  })
  it('returns launch null for a known terminal with no record', async () => {
    const response = await dispatcher.dispatch(request('terminal.why'))
    expect({ ok: response.ok, result: response.ok ? response.result : undefined }).toEqual({
      ok: true,
      result: {
        why: {
          terminal: handle,
          ptyId: 'pty-1',
          paneKey: '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
          launch: null
        }
      }
    })
  })
  it('looks up a legacy pane by pty id without constructing an invalid pane key', async () => {
    writeFileSync(join(directory, LAUNCH_LEDGER_FILE), `${JSON.stringify(row)}\n`)
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      tabId: 'legacy-tab',
      leafId: '1',
      ptyId: 'pty-1'
    } as never)
    const response = await dispatcher.dispatch(request('terminal.why'))
    expect(response.ok ? response.result : response.error).toEqual({
      why: { terminal: handle, ptyId: 'pty-1', paneKey: null, launch: row }
    })
  })
  it('matches terminal.show not-found for an unknown handle', async () => {
    const shown = await dispatcher.dispatch(request('terminal.show', 'term_missing'))
    const why = await dispatcher.dispatch(request('terminal.why', 'term_missing'))
    expect(why.ok).toBe(false)
    expect(why.ok ? null : why.error).toEqual(shown.ok ? null : shown.error)
  })
})
