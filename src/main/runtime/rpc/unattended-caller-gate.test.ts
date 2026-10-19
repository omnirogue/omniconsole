import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeRpcServer } from '../runtime-rpc'
import { SESSION_MANAGE_RPC } from '../../../shared/session-manage-types'
import { registerUnattendedPane } from '../../session-manage/session-manage-unattended'
import { actorFor } from './methods/session-manage-support'
import { defineMethod, type RpcContext } from './core'
import { setUnattendedCallerBinding, UNATTENDED_CALLER_METHODS } from './unattended-caller-gate'

vi.mock('../../omni-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => '/nonexistent'
}))

const CONTEXT = { source: 'cleanup-run' as const, runId: 'run-1', since: 1 }
const METHODS = [
  'terminal.send',
  'terminal.rename',
  'terminal.create',
  'automation.runNow',
  'sessionFolders.mutate',
  'sessionOrganization.organize',
  'sessionManage.show',
  'sessionManage.list',
  'sessionManage.tidy'
]

let dir = ''
let server: OrcaRuntimeRpcServer
let seen: { method: string; context: RpcContext }[] = []
const cleanups: (() => void)[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omni-unattended-gate-'))
  seen = []
  server = new OrcaRuntimeRpcServer({
    runtime: { getRuntimeId: () => 'gate-runtime', getStartedAt: () => 1 } as never,
    userDataPath: dir,
    methods: METHODS.map((name) =>
      defineMethod({
        name,
        params: null,
        handler: (_params, context) => {
          seen.push({ method: name, context })
          return { ran: name }
        }
      })
    )
  })
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
  rmSync(dir, { recursive: true, force: true })
})

function call(method: string, extra: Record<string, unknown> = {}) {
  const message = JSON.stringify({
    id: `req-${method}`,
    authToken: server['authToken'],
    method,
    ...extra
  })
  return server['handleMessage'](message) as Promise<{
    ok: boolean
    error?: { code: string; message: string }
  }>
}

describe('the socket bound on an automatic cleanup session', () => {
  it('refuses typing into, renaming or launching terminals from a registered cleanup pane', async () => {
    cleanups.push(registerUnattendedPane('tab-c:leaf-1', CONTEXT))
    const evidence = { orchestrationCompatibilityEvidence: { paneKey: 'tab-c:leaf-1' } }

    for (const method of [
      'terminal.send',
      'terminal.rename',
      'terminal.create',
      'automation.runNow',
      'sessionFolders.mutate',
      'sessionOrganization.organize',
      'sessionManage.show'
    ]) {
      await expect(call(method, evidence)).resolves.toMatchObject({
        ok: false,
        error: { code: 'unattended_refused', message: expect.stringContaining(method) }
      })
    }
    expect(seen).toEqual([])

    await expect(call('sessionManage.tidy', evidence)).resolves.toMatchObject({ ok: true })
    expect(seen[0]?.context.unattendedCaller).toMatchObject({ runId: 'run-1' })
  })

  it('binds a caller with no pane evidence by its process tree, and fails closed on error', async () => {
    const binding = vi.fn(async ({ callerPid }: { callerPid?: number }) =>
      callerPid === 230 ? CONTEXT : null
    )
    cleanups.push(setUnattendedCallerBinding(binding))

    await expect(call('terminal.send', { callerPid: 230 })).resolves.toMatchObject({
      error: { code: 'unattended_refused' }
    })
    await expect(call('terminal.send', { callerPid: 330 })).resolves.toMatchObject({ ok: true })
    expect(binding).toHaveBeenCalledWith({ callerPid: 330, evidence: undefined })
    // A forged pid of 0/1 or a string is no pid at all.
    await call('sessionManage.list', { callerPid: '230' })
    expect(binding).toHaveBeenLastCalledWith({ callerPid: undefined, evidence: undefined })

    binding.mockRejectedValueOnce(new Error('process table unreadable'))
    await expect(call('terminal.rename')).resolves.toMatchObject({
      error: { code: 'unattended_refused' }
    })
  })

  it('leaves every caller alone when nothing binds it', async () => {
    await expect(call('terminal.send')).resolves.toMatchObject({ ok: true })
    expect(seen[0]?.context.unattendedCaller).toBeUndefined()
  })

  it('stamps the bound context on the session-manage actor', () => {
    const actor = actorFor({ runtime: {} as never, unattendedCaller: CONTEXT } as RpcContext, [])
    expect(actor).toEqual({ kind: 'cli', unattended: CONTEXT })
  })

  it('allows only reads, tidy and the steward-limited ask/continue', () => {
    expect([...UNATTENDED_CALLER_METHODS].toSorted()).toEqual([
      'sessionFolders.list',
      'sessionManage.ask',
      'sessionManage.conflicts',
      'sessionManage.continue',
      'sessionManage.findOwner',
      'sessionManage.list',
      'sessionManage.tidy',
      'sessionOrganization.actions',
      'sessionOrganization.history',
      'sessionOrganization.recent',
      'sessionSearch.query',
      'status.get'
    ])
  })

  it('refuses what S1 refuses unattended callers: #751 resume, --when-idle holds and assign', () => {
    for (const method of [
      SESSION_MANAGE_RPC.resume,
      SESSION_MANAGE_RPC.continueWhenIdle,
      SESSION_MANAGE_RPC.assign,
      SESSION_MANAGE_RPC.pending
    ]) {
      expect(UNATTENDED_CALLER_METHODS.has(method)).toBe(false)
    }
  })
})

describe('the socket caller pid', () => {
  it('reaches the handler context from the socket, only as a real pid', async () => {
    for (const callerPid of [4321, 1, 'x']) {
      await expect(call('sessionManage.list', { callerPid })).resolves.toMatchObject({ ok: true })
    }
    expect(seen.map((entry) => entry.context.callerPid)).toEqual([4321, undefined, undefined])
  })
})
