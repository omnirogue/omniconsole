import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LaunchLedgerRow } from '../../shared/launch-ledger'
import { adapterFor, fakeClaude, identityFor } from './claude-structured-session-test-support'
import {
  flushLaunchLedger,
  setLaunchLedgerDirectory,
  _resetLaunchLedgerForTests
} from '../launch-ledger/launch-ledger'
import * as receipt from '../launch-ledger/structured-session-launch-record'

const SESSION = 'claude_11111111_1111_4111_8111_111111111111'
let root: string
const adapters: ReturnType<typeof adapterFor>[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const adapter of adapters.splice(0)) {
    await adapter.closeSession(SESSION)
  }
  await _resetLaunchLedgerForTests()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})
async function fixture(options: Parameters<typeof fakeClaude>[0] = {}) {
  root = await mkdtemp(join(tmpdir(), 'claude-launch-receipt-'))
  await setLaunchLedgerDirectory(root)
  const claude = fakeClaude(options)
  const adapter = adapterFor(claude)
  adapters.push(adapter)
  const input = {
    identity: {
      ...identityFor(SESSION),
      workspaceId: 'folder:22222222-2222-4222-8222-222222222222'
    },
    fence: 7,
    spawnToken: 'private-spawn-token',
    launchCause: { trigger: 'agent-session-create' as const, actor: { kind: 'app' as const } }
  }
  return { claude, adapter, input }
}
async function records() {
  await flushLaunchLedger()
  const text = await readFile(join(root, 'launch-ledger.ndjson'), 'utf8').catch(() => '')
  expect(text).not.toMatch(
    /private-spawn-token|\/accounts|\/work|initialization failed|option transport failed/
  )
  const events: LaunchLedgerRow[] = text.trim()
    ? text
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    : []
  const rows = [...new Map(events.map((row) => [row.launchId, row])).values()]
  return { events, rows }
}
describe('Claude execution-owner ledger', () => {
  it('retains one child-start receipt when initialization fails after spawn', async () => {
    const { adapter, claude, input } = await fixture({ exitBeforeInit: 'initialization failed' })
    await expect(adapter.acquire(input)).rejects.toThrow('initialization failed')
    expect(claude.connections).toHaveLength(1)
    expect(claude.connections[0].closeCount).toBe(1)
    const { rows, events } = await records()
    expect(rows).toEqual([
      {
        v: 1,
        ts: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
        launchId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        pipeline: 'structured-agent-session',
        ptyId: null,
        worktreeId: input.identity.workspaceId,
        agent: 'claude',
        cause: 'agent-session-create',
        actor: { kind: 'app' },
        process: 'created',
        hasStartupCommand: false,
        outcome: 'failed-after-start',
        reference: { agentSessionId: SESSION }
      }
    ])
    expect(events.filter((event) => !event.outcome)).toHaveLength(1)
    expect(events.filter((event) => event.outcome === 'failed-after-start')).toHaveLength(1)
  })
  it('retains one child-start receipt when option restoration fails after spawn', async () => {
    const error = new Error('option transport failed')
    const { adapter, claude, input } = await fixture({
      routes: {
        set_permission_mode: () => {
          throw error
        }
      }
    })
    await expect(
      adapter.acquire({ ...input, options: { permissionMode: 'bypassPermissions' } })
    ).rejects.toBe(error)
    expect(claude.connections).toHaveLength(1)
    expect(claude.connections[0].closeCount).toBe(1)
    expect((await records()).rows).toEqual([
      expect.objectContaining({ process: 'created', outcome: 'failed-after-start' })
    ])
  })
  it('invokes the guarded start recorder even when its export throws', async () => {
    const { adapter, input } = await fixture()
    const recording = vi.spyOn(receipt, 'recordStructuredSessionStart').mockImplementation(() => {
      throw new Error('private diagnostic failure')
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(adapter.acquire(input)).resolves.toMatchObject({ process: { pid: 4321 } })
    expect(recording).toHaveBeenCalledOnce()
  })
  it('preserves the original error and cleanup when the invoked start recorder throws', async () => {
    const error = new Error('option transport failed')
    const { adapter, claude, input } = await fixture({
      routes: {
        set_permission_mode: () => {
          throw error
        }
      }
    })
    const recording = vi.spyOn(receipt, 'recordStructuredSessionStart').mockImplementation(() => {
      throw new Error('private diagnostic failure')
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(
      adapter.acquire({ ...input, options: { permissionMode: 'bypassPermissions' } })
    ).rejects.toBe(error)
    expect(recording).toHaveBeenCalledOnce()
    expect(claude.connections[0].closeCount).toBe(1)
  })
})
