import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_SESSION_MANAGED_TOOLS_RUNTIME_CAPABILITY,
  AGENT_SESSION_VERIFIED_ACCOUNT_LAUNCH_RUNTIME_CAPABILITY
} from '../../shared/protocol-version'
import type { RuntimeClient } from '../runtime-client'
import { SESSION_LAUNCH_HANDLERS } from './session-launch'
const RUNTIME_ID = '11111111-1111-4111-8111-111111111111'
const VERIFIED = AGENT_SESSION_VERIFIED_ACCOUNT_LAUNCH_RUNTIME_CAPABILITY
let cwd = ''
let userData = ''
function fakeHost(overrides: Record<string, () => unknown> = {}) {
  const answers: Record<string, () => unknown> = {
    'status.get': () => ({
      runtimeId: RUNTIME_ID,
      appVersion: '1.12.19',
      capabilities: [VERIFIED]
    }),
    'worktree.list': () => ({ worktrees: [{ id: `repo::${cwd}`, path: cwd }] }),
    'terminal.agentLaunchReadiness': () => ({
      runtimeId: RUNTIME_ID,
      workspace: { id: `repo::${cwd}`, hostId: 'local', kind: 'git', path: cwd, name: 'fixture' }
    }),
    'terminal.createAgentSession': () => ({
      terminal: { handle: 'term_new', worktreeId: `repo::${cwd}`, title: null },
      disposition: 'created'
    }),
    ...overrides
  }
  const call = vi.fn(async (method: string, _params?: unknown) => ({
    id: 'r',
    ok: true,
    result: answers[method]?.(),
    _meta: { runtimeId: RUNTIME_ID }
  }))
  return { call, client: { call, isRemote: false } as unknown as RuntimeClient }
}
function launch(extra: [string, string | boolean][], host = fakeHost()) {
  const flags = new Map<string, string | boolean>([
    ['provider', 'codex'],
    ['prompt-file', 'brief.md'],
    ...extra
  ])
  return {
    call: host.call,
    run: () =>
      SESSION_LAUNCH_HANDLERS['session launch']!({ flags, client: host.client, cwd, json: true })
  }
}
function methods(call: ReturnType<typeof fakeHost>['call']) {
  return call.mock.calls.map(([method]) => method)
}
function sentRequest(call: ReturnType<typeof fakeHost>['call']) {
  return call.mock.calls.find(([method]) => method === 'terminal.createAgentSession')?.[1]
}
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'omni-managed-cwd-'))
  userData = mkdtempSync(join(tmpdir(), 'omni-managed-data-'))
  writeFileSync(join(cwd, 'brief.md'), 'Read authorized company knowledge.')
  vi.stubEnv('ORCA_USER_DATA_PATH', userData)
  vi.stubEnv('ORCA_ENVIRONMENT', '')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(cwd, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
})
describe('managed session CLI authority boundary', () => {
  it('refuses managed tools on an older runtime before launching', async () => {
    const id = `${Date.now()}-0123456789abcdef0123456789abcdef`
    const f = launch([
      ['operation-id', id],
      ['controller-runtime-id', RUNTIME_ID],
      ['managed-tools-file', '/private/descriptor']
    ])
    await expect(f.run()).rejects.toThrow('cannot attach managed session tools')
    expect(methods(f.call)).not.toContain('terminal.createAgentSession')
  })

  it('carries a managed attachment only with the explicit operation and verified host selection', async () => {
    const id = `${Date.now()}-0123456789abcdef0123456789abcdef`
    const host = fakeHost({
      'status.get': () => ({
        runtimeId: RUNTIME_ID,
        appVersion: '1.12.19',
        capabilities: [VERIFIED, AGENT_SESSION_MANAGED_TOOLS_RUNTIME_CAPABILITY]
      })
    })
    const f = launch(
      [
        ['operation-id', id],
        ['controller-runtime-id', RUNTIME_ID],
        ['managed-tools-file', '/private/descriptor']
      ],
      host
    )
    await f.run()
    expect(sentRequest(f.call)).toMatchObject({
      clientOperationId: id,
      managedToolsFile: '/private/descriptor',
      sshAccountSelection: { policy: 'best-verified', expectedRuntimeId: RUNTIME_ID }
    })
  })

  it('inspects exactly the requested native operation', async () => {
    const id = `${Date.now()}-0123456789abcdef0123456789abcdef`
    const host = fakeHost({
      'terminal.inspectAgentSessionLaunch': () => ({
        authority_verified: false,
        state: 'unverifiable'
      })
    })
    await SESSION_LAUNCH_HANDLERS['session launch-inspect']!({
      client: host.client,
      flags: new Map([['operation-id', id]]),
      cwd,
      json: true
    })
    expect(host.call).toHaveBeenCalledExactlyOnceWith('terminal.inspectAgentSessionLaunch', {
      operationId: id
    })
  })
})
