import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  recordLaunch,
  flushLaunchLedger,
  findLaunchRecord,
  setLaunchLedgerDirectory,
  _resetLaunchLedgerForTests,
  LAUNCH_LEDGER_FILE,
  LAUNCH_LEDGER_MAX_BYTES,
  LAUNCH_LEDGER_MAX_FILES,
  type LaunchLedgerInput,
  type LaunchLedgerRow
} from './launch-ledger'
import {
  setLatencyTelemetryEnabledReader,
  _resetLatencyTelemetryEnabledReaderForTests
} from '../observability/latency-probe-switch'

let directory: string
const cause = {
  trigger: 'cli' as const,
  reference: {
    automationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    automationRunId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  },
  actor: {
    kind: 'paired-device' as const,
    deviceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    clientKind: 'runtime' as const
  },
  requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  parentPaneKey: '33333333-3333-4333-8333-333333333333:44444444-4444-4444-8444-444444444444'
}
const input: LaunchLedgerInput = {
  pipeline: 'runtime-controller',
  ptyId: 'pty-1',
  paneKey: '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
  tabId: '11111111-1111-4111-8111-111111111111',
  worktreeId: 'folder:99999999-9999-4999-8999-999999999999',
  agent: 'claude',
  cause,
  hasStartupCommand: true,
  visible: false,
  process: 'created'
}
async function rows(file = LAUNCH_LEDGER_FILE): Promise<LaunchLedgerRow[]> {
  await flushLaunchLedger()
  const path = join(directory, file)
  return existsSync(path)
    ? readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []
}
function expected(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    ts: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    pipeline: 'runtime-controller',
    ptyId: 'pty-1',
    paneKey: '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
    tabId: '11111111-1111-4111-8111-111111111111',
    worktreeId: 'folder:99999999-9999-4999-8999-999999999999',
    agent: 'claude',
    cause: 'cli',
    reference: cause.reference,
    actor: cause.actor,
    requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    parentPaneKey: '33333333-3333-4333-8333-333333333333:44444444-4444-4444-8444-444444444444',
    hasStartupCommand: true,
    visible: false,
    process: 'created',
    ...overrides
  }
}
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'launch-ledger-red-'))
  await _resetLaunchLedgerForTests()
  await setLaunchLedgerDirectory(directory)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(async () => {
  await _resetLaunchLedgerForTests()
  _resetLatencyTelemetryEnabledReaderForTests()
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})
describe('durable launch ledger', async () => {
  it('writes exactly one complete row', async () => {
    recordLaunch(input)
    expect(await rows()).toEqual([expected()])
  })
  it('retains a failed-after-start outcome under the original creation id', async () => {
    const launchId = '77777777-7777-4777-8777-777777777777'
    const ts = '2026-10-03T00:00:00.000Z'
    recordLaunch({ ...input, launchId, ts })
    recordLaunch({ ...input, launchId, ts, outcome: 'failed-after-start' })
    expect(await rows()).toEqual([
      expected({ launchId, ts }),
      expected({ launchId, ts, outcome: 'failed-after-start' })
    ])
    expect(await findLaunchRecord({ ptyId: 'pty-1' })).toEqual(
      expected({ launchId, ts, outcome: 'failed-after-start' })
    )
  })
  it('records a plain shell and omits the agent key', async () => {
    recordLaunch({
      pipeline: 'runtime-controller',
      ptyId: 'pty-101',
      hasStartupCommand: false,
      process: 'created',
      cause: { trigger: 'cli' }
    })
    expect(await rows()).toEqual([
      {
        v: 1,
        ts: expected().ts,
        pipeline: 'runtime-controller',
        ptyId: 'pty-101',
        hasStartupCommand: false,
        process: 'created',
        cause: 'cli'
      }
    ])
  })
  it('records missing cause as unknown and warns once with the pipeline', async () => {
    recordLaunch({ ...input, cause: undefined })
    expect(await rows()).toEqual(
      [
        expected({
          cause: 'unknown',
          reference: undefined,
          actor: undefined,
          requestId: undefined,
          parentPaneKey: undefined
        })
      ].map((row) => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined)))
    )
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringMatching(/^\[launch-ledger\].*runtime-controller/)
    )
  })
  it('copies only allowed fields and never stores prompt, env, cwd or reference text', async () => {
    recordLaunch({
      ...input,
      command: 'claude --secret-flag PROMPT-TEXT',
      env: { TOKEN: 'sk-test-123' },
      cwd: '/tmp/private-path',
      cause: { ...cause, reference: { ...cause.reference, freeText: 'PROMPT-TEXT' } }
    } as LaunchLedgerInput)
    expect(await rows()).toEqual([expected()])
    const text = readFileSync(join(directory, LAUNCH_LEDGER_FILE), 'utf8')
    for (const secret of ['PROMPT-TEXT', '--secret-flag', 'sk-test-123', '/tmp/private-path']) {
      expect(text).not.toContain(secret)
    }
  })
  it('writes with latency telemetry disabled', async () => {
    setLatencyTelemetryEnabledReader(() => false)
    recordLaunch(input)
    expect(await rows()).toEqual([expected()])
  })
  it('bounds the rotated family and retains the newest row', async () => {
    await setLaunchLedgerDirectory(directory, { maxBytes: 4096 })
    expect(LAUNCH_LEDGER_MAX_BYTES).toBe(2 * 1024 * 1024)
    expect(LAUNCH_LEDGER_MAX_FILES).toBe(3)
    for (let i = 0; i < 30; i++) {
      recordLaunch({
        ...input,
        ptyId: `pty-${i}`,
        cause: { ...cause, requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }
      })
      await flushLaunchLedger()
    }
    await flushLaunchLedger()
    const files = readdirSync(directory).filter((name) =>
      /^launch-ledger\.ndjson(?:\.\d+)?$/.test(name)
    )
    expect(files.length).toBeGreaterThan(1)
    expect(files.length).toBeLessThanOrEqual(LAUNCH_LEDGER_MAX_FILES)
    for (const file of files) {
      expect(statSync(join(directory, file)).size).toBeLessThanOrEqual(4096)
    }
    expect((await rows()).at(-1)).toEqual(
      expected({ ptyId: 'pty-29', requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' })
    )
  })
  it('prefers the newest created row over later attaches', async () => {
    recordLaunch(input)
    recordLaunch({
      ...input,
      cause: { trigger: 'cli', requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeea' }
    })
    recordLaunch({
      ...input,
      process: 'attached',
      cause: { trigger: 'cli', requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeeb' }
    })
    await flushLaunchLedger()
    expect(await findLaunchRecord({ ptyId: 'pty-1' })).toEqual(
      Object.fromEntries(
        Object.entries(
          expected({
            reference: undefined,
            actor: undefined,
            parentPaneKey: undefined,
            requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeea'
          })
        ).filter(([, v]) => v !== undefined)
      )
    )
  })
  it('falls back to pane key and returns null for an unknown pty', async () => {
    recordLaunch(input)
    await flushLaunchLedger()
    expect(
      await findLaunchRecord({
        ptyId: 'missing',
        paneKey: '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222'
      })
    ).toEqual(expected())
    expect(await findLaunchRecord({ ptyId: 'missing' })).toBeNull()
  })
  it('uses the newest attach when no created row exists', async () => {
    recordLaunch({ ...input, process: 'attached' })
    await flushLaunchLedger()
    expect(await findLaunchRecord({ ptyId: 'pty-1' })).toEqual(expected({ process: 'attached' }))
  })
  it('finds a row in the first rotated file', async () => {
    await setLaunchLedgerDirectory(directory, { maxBytes: 2048 })
    recordLaunch(input)
    for (let i = 0; i < 2; i++) {
      recordLaunch({ ...input, ptyId: `pty-${i + 100}` })
    }
    await flushLaunchLedger()
    expect((await rows(`${LAUNCH_LEDGER_FILE}.1`)).some((row) => row.ptyId === 'pty-1')).toBe(true)
    expect(await findLaunchRecord({ ptyId: 'pty-1' })).toEqual(expected())
  })
})
