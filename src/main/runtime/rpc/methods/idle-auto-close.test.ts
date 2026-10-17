import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDLE_AUTO_CLOSE_RPC, IDLE_RULE } from '../../../../shared/idle-auto-close-settings'
import type { SessionManageSidebarRow } from '../../../../shared/session-manage-relay'
import { SESSION_ACTIONS_FILE } from '../../../session-manage/session-actions-log'
import {
  readIdleKeepReadings,
  type IdleKeepReadingDeps
} from '../../../session-manage/session-idle-keep-reading'
import { readSessionActions } from '../../../session-organization/organization-actions-reader'
import type { RpcContext, RpcMethod } from '../core'

const state = vi.hoisted(() => ({ dir: '' }))

vi.mock('../../../omni-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => state.dir
}))

// Why: the runtime readings need a live window and runtime; the pure reader takes them as deps.
vi.mock('../../../session-manage/session-manage-runtime-actions', () => ({
  readSidebarRows: vi.fn()
}))
vi.mock('../../../session-manage/session-manage-runtime-sources', () => ({
  createRuntimeObserveSources: () => ({}),
  runtimeNeverReplied: () => () => false,
  snapshotRuntimeLatestTurn: () => ({ text: null })
}))

const { IDLE_AUTO_CLOSE_METHODS } = await import('./idle-auto-close')
const { SESSION_ORGANIZATION_WINDOW_ONLY_ERROR } = await import('./session-organization')

const WINDOW = {
  clientId: 'desktop-renderer',
  clientKind: 'runtime',
  connectionId: 'desktop-renderer:1'
} as const

function call<T>(
  name: string,
  params: unknown,
  extra: Partial<RpcContext> = WINDOW,
  runtime: object = {}
): Promise<T> {
  const method = IDLE_AUTO_CLOSE_METHODS.find((entry) => entry.name === name) as RpcMethod
  const parsed = method.params ? method.params.parse(params) : params
  return Promise.resolve(
    method.handler(parsed, { ...extra, runtime: runtime as RpcContext['runtime'] } as RpcContext)
  ) as Promise<T>
}

const sleepRecord = {
  action: 'hibernation.sleep',
  target: { paneKey: 'tab-1:leaf', tabId: 'tab-1', title: 'Claude' },
  summary: 'Put a done agent to sleep after 42 idle minutes; opening it resumes it.',
  audit: {
    rule: IDLE_RULE.R1,
    mode: 'on',
    outcome: 'done',
    evidence: { source: 'hibernation', idleForMs: 2_520_000, ptyId: 'pty-1' }
  }
} as const

beforeEach(() => {
  state.dir = mkdtempSync(join(tmpdir(), 'idle-auto-close-rpc-'))
})

afterEach(() => {
  rmSync(state.dir, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('idleAutoClose.record', () => {
  it('appends one line with actor hibernation, the rule as reason and its evidence', async () => {
    await expect(call(IDLE_AUTO_CLOSE_RPC.record, { records: [sleepRecord] })).resolves.toEqual({
      written: 1
    })
    const lines = readFileSync(join(state.dir, SESSION_ACTIONS_FILE), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({
      actor: 'hibernation',
      action: 'hibernation.sleep',
      reason: IDLE_RULE.R1,
      target: { paneKey: 'tab-1:leaf', tabId: 'tab-1' },
      hibernation: { rule: IDLE_RULE.R1, mode: 'on', outcome: 'done', evidence: { ptyId: 'pty-1' } }
    })
    // `omni session actions --actor hibernation` finds it.
    const found = await readSessionActions(join(state.dir, SESSION_ACTIONS_FILE), {
      since: 0,
      actors: ['hibernation'],
      limit: 10
    })
    expect(found.map((line) => line.action)).toEqual(['hibernation.sleep'])
  })

  it('takes records only from this computer’s window', async () => {
    for (const extra of [
      {},
      { pairedDeviceId: 'phone', clientKind: 'mobile' as const },
      { clientId: 'desktop-renderer', clientKind: 'runtime' as const, connectionId: 'ws:1' }
    ]) {
      await expect(
        call(IDLE_AUTO_CLOSE_RPC.record, { records: [sleepRecord] }, extra)
      ).rejects.toThrow(SESSION_ORGANIZATION_WINDOW_ONLY_ERROR)
    }
  })

  it('refuses oversized or malformed batches before writing', () => {
    const method = IDLE_AUTO_CLOSE_METHODS.find(
      (entry) => entry.name === IDLE_AUTO_CLOSE_RPC.record
    )!
    const bad = [
      { records: Array.from({ length: 51 }, () => sleepRecord) },
      { records: [{ ...sleepRecord, summary: 'x'.repeat(501) }] },
      { records: [{ ...sleepRecord, audit: { ...sleepRecord.audit, rule: 'made-up' } }] },
      { records: [{ ...sleepRecord, action: 'session.stop' }] }
    ]
    for (const params of bad) {
      expect(() => method.params!.parse(params)).toThrow()
    }
  })
})

function row(paneKey: string, worktreeId = 'wt'): SessionManageSidebarRow {
  return { paneKey, worktreeId, tabId: paneKey.split(':')[0]!, kind: 'terminal' } as never
}

describe('readIdleKeepReadings (G1)', () => {
  function deps(overrides: Partial<IdleKeepReadingDeps> = {}): IdleKeepReadingDeps {
    return {
      rows: async () => [row('tab-1:a'), row('tab-2:b'), row('tab-3:c')],
      observe: async (target) =>
        target.paneKey === 'tab-2:b'
          ? { state: 'awaiting-user', keepGoing: false, agentForeground: true }
          : {
              state: 'idle',
              keepGoing: target.paneKey === 'tab-3:c',
              agentForeground: target.paneKey === 'tab-3:c' ? null : true
            },
      replies: (source) =>
        source.paneKey === 'tab-1:a' ? [null, 'Questions:\n1. Phase 0?\n2. 30 minutes?'] : [],
      ...overrides
    }
  }

  it('reads the A1 state, Keep going and any asking reply per pane', async () => {
    const readings = await readIdleKeepReadings(deps(), [
      { worktreeId: 'wt', paneKey: 'tab-1:a' },
      { worktreeId: 'wt', paneKey: 'tab-2:b' },
      { worktreeId: 'wt', paneKey: 'tab-3:c' },
      { worktreeId: 'wt', paneKey: 'tab-9:z' }
    ])
    expect(readings).toEqual([
      {
        paneKey: 'tab-1:a',
        listed: true,
        state: 'idle',
        openAsk: true,
        keepGoing: false,
        agentForeground: true
      },
      {
        paneKey: 'tab-2:b',
        listed: true,
        state: 'awaiting-user',
        openAsk: false,
        keepGoing: false,
        agentForeground: true
      },
      {
        paneKey: 'tab-3:c',
        listed: true,
        state: 'idle',
        openAsk: false,
        keepGoing: true,
        agentForeground: null
      },
      {
        paneKey: 'tab-9:z',
        listed: false,
        state: null,
        openAsk: false,
        keepGoing: false,
        agentForeground: null
      }
    ])
  })

  it('carries the pid proof that the row’s own agent holds the terminal, or its absence', async () => {
    const readings = await readIdleKeepReadings(
      deps({
        observe: async (target) =>
          target.paneKey === 'tab-1:a'
            ? { state: 'exited', keepGoing: false, agentForeground: false }
            : { state: 'idle', keepGoing: false, agentForeground: true }
      }),
      [
        { worktreeId: 'wt', paneKey: 'tab-1:a' },
        { worktreeId: 'wt', paneKey: 'tab-2:b' }
      ]
    )
    expect(readings.map((reading) => [reading.state, reading.agentForeground])).toEqual([
      ['exited', false],
      ['idle', true]
    ])
    // A failed reading never claims an agent.
    const [failed] = await readIdleKeepReadings(
      deps({ observe: () => Promise.reject(new Error('screen')) }),
      [{ worktreeId: 'wt', paneKey: 'tab-1:a' }]
    )
    expect(failed).toMatchObject({ failed: true, agentForeground: null })
  })

  it('marks every reading failed when rows cannot be read, and one that throws', async () => {
    await expect(
      readIdleKeepReadings(deps({ rows: () => Promise.reject(new Error('no window')) }), [
        { worktreeId: 'wt', paneKey: 'tab-1:a' }
      ])
    ).resolves.toEqual([expect.objectContaining({ paneKey: 'tab-1:a', failed: true })])
    await expect(
      readIdleKeepReadings(deps({ observe: () => Promise.reject(new Error('screen')) }), [
        { worktreeId: 'wt', paneKey: 'tab-1:a' }
      ])
    ).resolves.toEqual([expect.objectContaining({ paneKey: 'tab-1:a', failed: true })])
  })

  it('does not take another workspace’s row for the pane', async () => {
    const [reading] = await readIdleKeepReadings(deps(), [
      { worktreeId: 'other', paneKey: 'tab-1:a' }
    ])
    expect(reading).toMatchObject({ listed: false })
  })

  it('answers only the window', async () => {
    await expect(
      call(
        IDLE_AUTO_CLOSE_RPC.keepReadings,
        { targets: [{ worktreeId: 'wt', paneKey: 'p' }] },
        { pairedDeviceId: 'phone' }
      )
    ).rejects.toThrow(SESSION_ORGANIZATION_WINDOW_ONLY_ERROR)
  })
})

describe('idleAutoClose methods', () => {
  it('offers no scrollback save: R2 keeps history by sleeping shells, never closing a tab', () => {
    expect(IDLE_AUTO_CLOSE_METHODS.map((entry) => entry.name).sort()).toEqual(
      [IDLE_AUTO_CLOSE_RPC.keepReadings, IDLE_AUTO_CLOSE_RPC.record].sort()
    )
  })
})
