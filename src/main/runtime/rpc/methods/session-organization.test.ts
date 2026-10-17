import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionFolderRendererRequest } from '../../../../shared/session-folder-cli'
import {
  SESSION_ORGANIZATION_RPC,
  type OrganizationChange,
  type OrganizationHistory,
  type OrganizationRecord,
  type OrganizationUndoPlan
} from '../../../../shared/session-organization-change'
import type { OrganizationSessionHistory } from '../../../../shared/session-organization-readers'
import { ARCHIVE_SLEEP_REASONS } from '../../../../shared/archive-sleep-contract'
import { SESSION_ACTIONS_FILE } from '../../../session-manage/session-actions-log'
import { organizationTrailLine } from '../../../session-organization/organization-trail'
import type { RpcContext, RpcMethod } from '../core'

const state = vi.hoisted(() => ({ dir: '' }))

vi.mock('../../../omni-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => state.dir
}))

const {
  SESSION_ORGANIZATION_LOCAL_ONLY_ERROR,
  SESSION_ORGANIZATION_METHODS,
  SESSION_ORGANIZATION_WINDOW_ONLY_ERROR
} = await import('./session-organization')

const WINDOW = {
  clientId: 'desktop-renderer',
  clientKind: 'runtime',
  connectionId: 'desktop-renderer:1'
} as const

function call<T>(name: string, params: unknown, extra: Partial<RpcContext> = WINDOW): Promise<T> {
  const method = SESSION_ORGANIZATION_METHODS.find((entry) => entry.name === name) as RpcMethod
  const parsed = method.params ? method.params.parse(params) : params
  const runtime = extra.runtime ?? ({} as RpcContext['runtime'])
  return Promise.resolve(method.handler(parsed, { ...extra, runtime } as RpcContext)) as Promise<T>
}

const drag: OrganizationChange = {
  opId: 'drag-1',
  kind: 'move',
  targets: [{ sessionKey: 's1' }],
  value: 'checkout',
  executor: { kind: 'person', via: 'sidebar' }
}

beforeEach(() => {
  state.dir = mkdtempSync(join(tmpdir(), 'session-organization-rpc-'))
})

afterEach(() => {
  rmSync(state.dir, { recursive: true, force: true })
})

describe('sessionOrganization.* callers', () => {
  it('takes changes only from this computer’s window, not the CLI, a phone or an agent', async () => {
    for (const extra of [
      {},
      { pairedDeviceId: 'phone', clientKind: 'mobile' as const },
      {
        ...WINDOW,
        orchestrationCompatibilityEvidence: {} as RpcContext['orchestrationCompatibilityEvidence']
      },
      { clientId: 'desktop-renderer', clientKind: 'runtime' as const, connectionId: 'ws:1' }
    ]) {
      await expect(
        call(SESSION_ORGANIZATION_RPC.settle, { phase: 'applied', change: drag }, extra)
      ).rejects.toThrow(SESSION_ORGANIZATION_WINDOW_ONLY_ERROR)
    }
  })

  it('answers history to the window and the local CLI, never a paired device', async () => {
    await call(SESSION_ORGANIZATION_RPC.settle, {
      phase: 'applied',
      change: drag,
      before: [null],
      after: ['checkout']
    })
    for (const extra of [WINDOW, {}]) {
      const history = await call<OrganizationHistory>(
        SESSION_ORGANIZATION_RPC.history,
        { key: 's1' },
        extra
      )
      expect(history.entries.map((entry) => [entry.opId, entry.executor])).toEqual([
        ['drag-1', { kind: 'person', via: 'sidebar' }]
      ])
    }
    await expect(
      call(SESSION_ORGANIZATION_RPC.history, { key: 's1' }, { pairedDeviceId: 'p', clientId: 'c' })
    ).rejects.toThrow(SESSION_ORGANIZATION_LOCAL_ONLY_ERROR)
  })
})

describe('sessionOrganization.* round trip', () => {
  it('prepares, settles with a revision, lists recent changes and plans their Undo', async () => {
    const agent: OrganizationChange = {
      ...drag,
      opId: 'launch-1',
      executor: { kind: 'app', feature: 'auto-archive' },
      kind: 'archive',
      value: true
    }
    await call(SESSION_ORGANIZATION_RPC.prepare, { change: agent, before: [false] })
    await expect(
      call(SESSION_ORGANIZATION_RPC.settle, { phase: 'applied', change: agent, after: [true] })
    ).resolves.toEqual({ revision: 'launch-1' })
    const recent = await call<{ entries: { opId: string }[] }>(SESSION_ORGANIZATION_RPC.recent, {
      executors: ['app']
    })
    expect(recent.entries.map((entry) => entry.opId)).toEqual(['launch-1'])
    const plan = await call<OrganizationUndoPlan>(SESSION_ORGANIZATION_RPC.undoPlan, {
      opId: 'launch-1'
    })
    expect(plan.inverse).toMatchObject({ kind: 'unarchive', value: false, undoOf: 'launch-1' })
  })

  it('reconciles a change a crash left prepared by asking the window through the folder relay', async () => {
    // Written before this directory's first call: the ledger reads it as the last run's trail.
    const prepared: OrganizationRecord = {
      ...drag,
      opId: 'crash-1',
      executor: { kind: 'cli' },
      phase: 'prepared',
      ts: '2026-09-25T09:00:00.000Z'
    }
    appendFileSync(
      join(state.dir, SESSION_ACTIONS_FILE),
      `${JSON.stringify(organizationTrailLine(prepared))}\n`
    )
    const requests: SessionFolderRendererRequest[] = []
    const runtime = {
      requestSessionFolders: vi.fn(async (request: SessionFolderRendererRequest) => {
        requests.push(request)
        return { answers: [{ opId: 'crash-1', holds: true, after: ['checkout'] }] }
      })
    } as unknown as RpcContext['runtime']
    const result = await call(SESSION_ORGANIZATION_RPC.reconcile, undefined, { ...WINDOW, runtime })
    expect(result).toEqual({ applied: ['crash-1'], failed: [], pending: 0 })
    expect(requests).toEqual([
      { kind: 'probeOrganization', records: [expect.objectContaining({ opId: 'crash-1' })] }
    ])
    const history = await call<OrganizationHistory>(SESSION_ORGANIZATION_RPC.history, { key: 's1' })
    expect(history.entries[0]).toMatchObject({
      opId: 'crash-1',
      reconciled: true,
      revision: 'crash-1'
    })
    expect(history.pending).toEqual([])
  })
})

describe('sessionOrganization.noteArchiveSleep', () => {
  const note = {
    sessionKey: 'claude:abc',
    paneKey: 'tab-1:leaf-1',
    tabId: 'tab-1',
    title: 'Fix the build',
    via: 'person',
    trigger: 'archive',
    evidence: 'archive: Done since 2026-09-30T20:00:00.000Z; archived via person'
  }

  it('takes the line only from this computer’s window', async () => {
    for (const extra of [
      {},
      { pairedDeviceId: 'phone', clientKind: 'mobile' as const },
      { clientId: 'desktop-renderer', clientKind: 'runtime' as const, connectionId: 'ws:1' }
    ]) {
      await expect(call(SESSION_ORGANIZATION_RPC.noteArchiveSleep, note, extra)).rejects.toThrow(
        SESSION_ORGANIZATION_WINDOW_ONLY_ERROR
      )
    }
    expect(existsSync(join(state.dir, SESSION_ACTIONS_FILE))).toBe(false)
  })

  it('appends one app-authored sleep line with its evidence', async () => {
    expect(await call(SESSION_ORGANIZATION_RPC.noteArchiveSleep, note)).toEqual({})
    const lines = readFileSync(join(state.dir, SESSION_ACTIONS_FILE), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({
      actor: 'app',
      action: 'session.sleep',
      target: { paneKey: 'tab-1:leaf-1', tabId: 'tab-1', title: 'Fix the build' },
      before: { state: 'done', via: 'person', trigger: 'archive' },
      after: { sleeping: true, restoreOnTabOpenOnly: true, sessionKey: 'claude:abc' },
      summary: 'Archive paused the agent in "Fix the build"; opening it resumes the conversation.',
      reason: ARCHIVE_SLEEP_REASONS.archive,
      phase: 'applied',
      executor: { kind: 'app', feature: 'archive-sleep' },
      organization: { kind: 'sleep', evidence: note.evidence }
    })
  })

  it('shows the pause in the session’s History, after its archive, with nothing to undo', async () => {
    await call(SESSION_ORGANIZATION_RPC.settle, {
      phase: 'applied',
      change: {
        ...drag,
        opId: 'archive-1',
        kind: 'archive',
        targets: [{ sessionKey: 'claude:abc' }],
        value: true
      },
      before: [false],
      after: [true]
    })
    await call(SESSION_ORGANIZATION_RPC.noteArchiveSleep, note)
    for (const extra of [WINDOW, {}]) {
      const history = await call<OrganizationSessionHistory>(
        SESSION_ORGANIZATION_RPC.history,
        { key: 'claude:abc', aliases: ['pane:tab-1:leaf-1'] },
        extra
      )
      expect(history.entries.map((entry) => [entry.kind, entry.executor])).toEqual([
        ['sleep', { kind: 'app', feature: 'archive-sleep' }],
        ['archive', { kind: 'person', via: 'sidebar' }]
      ])
      expect(history.entries[0]).toMatchObject({
        phase: 'applied',
        reason: ARCHIVE_SLEEP_REASONS.archive,
        evidence: note.evidence
      })
      // Opening the conversation resumes it; Undo still puts back the archive itself.
      expect(history.undoable).toEqual(['archive-1'])
    }
    const recent = await call<{ entries: { kind: string }[] }>(SESSION_ORGANIZATION_RPC.recent, {
      kinds: ['sleep']
    })
    expect(recent.entries.map((entry) => entry.kind)).toEqual(['sleep'])
  })

  it('never lets the window settle a sleep through the change path', async () => {
    await expect(
      Promise.resolve().then(() =>
        call(SESSION_ORGANIZATION_RPC.settle, {
          phase: 'applied',
          change: { ...drag, opId: 'forged', kind: 'sleep', value: true }
        })
      )
    ).rejects.toThrow()
  })

  it('refuses unknown fields, unknown paths and oversized evidence', async () => {
    for (const params of [
      { ...note, actor: 'steward' },
      { ...note, via: 'agent' },
      { ...note, trigger: 'later' },
      { ...note, evidence: 'x'.repeat(1001) }
    ]) {
      await expect(
        Promise.resolve().then(() => call(SESSION_ORGANIZATION_RPC.noteArchiveSleep, params))
      ).rejects.toThrow()
    }
  })
})

describe('sessionOrganization.archiveSleepReading', () => {
  const target = { paneKey: 'tab-1:leaf-1', tabId: 'tab-1', worktreeId: 'wt' }

  it('answers only this computer’s window', async () => {
    for (const extra of [
      {},
      { pairedDeviceId: 'phone', clientKind: 'mobile' as const },
      { clientId: 'desktop-renderer', clientKind: 'runtime' as const, connectionId: 'ws:1' }
    ]) {
      await expect(
        Promise.resolve().then(() =>
          call(SESSION_ORGANIZATION_RPC.archiveSleepReading, target, extra)
        )
      ).rejects.toThrow(SESSION_ORGANIZATION_WINDOW_ONLY_ERROR)
    }
  })

  it('keeps the agent when the window’s rows cannot be read', async () => {
    const runtime = {
      requestSessionFolders: vi.fn(async () => {
        throw new Error('no window')
      })
    } as unknown as RpcContext['runtime']
    expect(
      await call(SESSION_ORGANIZATION_RPC.archiveSleepReading, target, { ...WINDOW, runtime })
    ).toEqual({ clear: false, keep: 'unreadable' })
  })

  it('refuses unknown fields', () => {
    expect(() =>
      call(SESSION_ORGANIZATION_RPC.archiveSleepReading, { ...target, force: true })
    ).toThrow()
  })
})
