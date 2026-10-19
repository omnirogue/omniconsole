// An automatic cleanup session is unattended whatever its pane identity or brief says: its own
// `omni session tidy --apply` archives only what Tier 2 passes, through the real change path.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionFolderRendererRequest } from '../../../../shared/session-folder-cli'
import type { SessionManageSidebarRow } from '../../../../shared/session-manage-relay'
import type {
  SessionManageActor,
  SessionManageEntry,
  SessionTidyResult
} from '../../../../shared/session-manage-types'
import { SESSION_ACTIONS_FILE } from '../../../session-manage/session-actions-log'
import { manageEntry, sidebarRow } from '../../../session-manage/session-manage-test-fixtures'
import { registerUnattendedPane } from '../../../session-manage/session-manage-unattended'
import {
  setStewardPolicyHooks,
  STEWARD_TIER2_UNAVAILABLE,
  type StewardTier2Check
} from '../../../session-manage/session-manage-unattended-admission'
import { configureStewardSwitches } from '../../../session-steward/steward-switches'
import { sessionOrganizationLedgerFor } from '../../../session-organization/organization-change-ledger'
import type { RpcContext } from '../core'

const CLEANUP_PANE = 'tab-7:leaf-1'

const state = vi.hoisted(() => ({
  dir: '',
  rows: [] as SessionManageSidebarRow[],
  entries: new Map<string, SessionManageEntry>(),
  actor: null as unknown as SessionManageActor
}))

// Why: no review or Question waits on these sessions; answer-wait.test.ts covers the reads.
vi.mock('../../../answer-delivery/answer-wait', () => ({
  answerWaitKeeper: () => () => null,
  agentAnswerWaitRefusal: () => null
}))
vi.mock('../../../omni-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => state.dir
}))
vi.mock('../../../session-manage/session-manage-runtime-actions', () => ({
  readSidebarRows: async () => state.rows
}))
vi.mock('../../../session-manage/session-manage-runtime-sources', () => ({
  createRuntimeObserveSources: () => ({})
}))
vi.mock('../../../session-manage/session-manage-observe', () => ({
  observeSession: async (row: SessionManageSidebarRow) => row
}))
vi.mock('../../../session-manage/session-manage-inventory', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  toSessionManageEntry: (row: SessionManageSidebarRow) => state.entries.get(row.paneKey!)!,
  observeSessionManageRows: async (rows: SessionManageSidebarRow[]) =>
    rows.map((row) => ({ row, entry: state.entries.get(row.paneKey!)! }))
}))
// The caller as its evidence proves it, stamped by the real registry (what `actorFor` does).
vi.mock('./session-manage-support', async () => {
  const { withUnattendedContext } =
    await import('../../../session-manage/session-manage-unattended')
  return { actorFor: () => withUnattendedContext(state.actor) }
})

const {
  SESSION_MANAGE_TIDY_METHOD,
  SESSION_TIDY_APPLY_NEEDS_REQUEST,
  SESSION_TIDY_UNATTENDED_INCLUDE
} = await import('./session-manage-tidy-method')
const { mutateSessionFolders, SESSION_FOLDER_UNATTENDED_LAUNCH } = await import('./session-folders')

const cleanups: (() => void)[] = []

function window() {
  const requestSessionFolders = vi.fn(async (request: SessionFolderRendererRequest) => {
    if (request.kind !== 'mutate' || !request.change) {
      throw new Error(`unexpected ${request.kind}`)
    }
    return {
      summary: 'Archived “Finished work”',
      sessionKey: 'k1',
      organization: {
        opId: request.change.opId,
        targets: [{ sessionKey: 'k1', paneKey: 'tab-1:leaf-1' }],
        value: true,
        before: [false],
        after: [true]
      }
    }
  })
  const context = {
    runtime: {
      getArtifactApiOrigin: () => null,
      listSessionChains: () => [],
      requestSessionFolders,
      listBackgroundRuntimeOwnedTerminals: () => null
    }
  } as unknown as RpcContext
  return { requestSessionFolders, context }
}

function run(context: RpcContext, params: Record<string, unknown>): Promise<SessionTidyResult> {
  return SESSION_MANAGE_TIDY_METHOD.handler(params, context) as Promise<SessionTidyResult>
}

function trail(): Record<string, unknown>[] {
  const path = join(state.dir, SESSION_ACTIONS_FILE)
  return existsSync(path)
    ? readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    : []
}

function tier2(check: StewardTier2Check): void {
  cleanups.push(setStewardPolicyHooks({ tier2Eligibility: check }))
}

beforeEach(() => {
  state.dir = mkdtempSync(join(tmpdir(), 'tidy-unattended-'))
  state.actor = { kind: 'pane', paneKey: CLEANUP_PANE, title: 'Session cleanup' }
  state.rows = [
    sidebarRow({ paneKey: 'tab-1:leaf-1', tabId: 'tab-1', rowKey: 'row-1', agentSession: true })
  ]
  state.entries = new Map([
    [
      'tab-1:leaf-1',
      manageEntry({ paneKey: 'tab-1:leaf-1', tabId: 'tab-1', state: 'exited', verdict: 'exited' })
    ]
  ])
  cleanups.push(configureStewardSwitches({ readSettings: () => ({}), environment: {} }))
  cleanups.push(registerUnattendedPane(CLEANUP_PANE, { source: 'cleanup-run', runId: 'run-1' }))
})

afterEach(async () => {
  while (cleanups.length) {
    cleanups.pop()!()
  }
  // Why: the history store writes after the change settles; remove the directory once it has.
  await sessionOrganizationLedgerFor(state.dir).flush()
  rmSync(state.dir, { recursive: true, force: true })
})

describe('session tidy --apply from an automatic cleanup session', () => {
  it('archives nothing without Tier 2, and needs no person’s words to say so', async () => {
    const { context, requestSessionFolders } = window()
    const result = await run(context, { apply: true })
    expect(result.rows[0]).toMatchObject({
      paneKey: 'tab-1:leaf-1',
      action: 'hold',
      reason: `Not archived by a steward run: ${STEWARD_TIER2_UNAVAILABLE}.`
    })
    expect(result.applied).toEqual({ archived: 0, skipped: 0, failed: 0 })
    expect(requestSessionFolders).not.toHaveBeenCalled()
    expect(trail()).toEqual([])
  })

  it('archives nothing when Tier 2 turns it down at the moment of archiving', async () => {
    let calls = 0
    tier2(async () =>
      (calls += 1) === 1
        ? { ok: true, evidence: 'JEV resolved 0.92' }
        : { ok: false, reason: 'new activity 2 minutes ago' }
    )
    const { context, requestSessionFolders } = window()
    const result = await run(context, { apply: true, request: 'clean up the sessions' })
    expect(result.rows[0]).toMatchObject({
      outcome: 'failed',
      outcomeReason: 'Not archived by a steward run: new activity 2 minutes ago.'
    })
    expect(requestSessionFolders).not.toHaveBeenCalled()
    expect(trail()).toEqual([])
  })

  it('archives what Tier 2 passes, recorded as unattended with the evidence, not a request', async () => {
    tier2(async () => ({ ok: true, evidence: 'JEV resolved 0.92 · quiet 7 h' }))
    const { context, requestSessionFolders } = window()
    const result = await run(context, { apply: true, request: 'words from the run’s brief' })
    expect(result.applied).toEqual({ archived: 1, skipped: 0, failed: 0 })
    expect(requestSessionFolders).toHaveBeenCalledTimes(1)
    const applied = trail().find((line) => line.phase === 'applied')!
    expect(applied).toMatchObject({
      actor: { paneKey: CLEANUP_PANE, title: 'Session cleanup' },
      unattended: { source: 'cleanup-run', runId: 'run-1' },
      action: 'session.archive',
      organization: { evidence: 'JEV resolved 0.92 · quiet 7 h' }
    })
    expect(applied.request).toBeUndefined()
  })

  it('may not name held sessions with --include', async () => {
    await expect(run(window().context, { apply: true, include: ['tab-1:leaf-1'] })).rejects.toThrow(
      SESSION_TIDY_UNATTENDED_INCLUDE
    )
  })

  it('leaves the on-request rule to a person’s own session', async () => {
    state.actor = { kind: 'pane', paneKey: 'tab-2:leaf-1', title: 'Manager' }
    await expect(run(window().context, { apply: true })).rejects.toThrow(
      SESSION_TIDY_APPLY_NEEDS_REQUEST
    )
    const { context, requestSessionFolders } = window()
    const result = await run(context, { apply: true, request: 'clean up the sessions' })
    expect(result.applied).toEqual({ archived: 1, skipped: 0, failed: 0 })
    expect(requestSessionFolders).toHaveBeenCalledTimes(1)
  })
})

describe('sessionFolders.mutate from an automatic cleanup session', () => {
  it('refuses a move, even one claimed as launch filing, before anything is recorded', async () => {
    const { context, requestSessionFolders } = window()
    const move = {
      kind: 'moveSession' as const,
      paneKey: 'tab-1:leaf-1',
      destination: 'folder' as const,
      folder: 'Checkout'
    }
    await expect(mutateSessionFolders(context, { op: move, reason: 'tidy up' })).rejects.toThrow(
      'A steward run cannot move, unarchive or delete sessions, or change folders'
    )
    await expect(
      mutateSessionFolders(context, { op: move, launch: 'session-launch' })
    ).rejects.toThrow(SESSION_FOLDER_UNATTENDED_LAUNCH)
    await expect(
      mutateSessionFolders(context, {
        op: { kind: 'deleteSession', paneKey: 'tab-1:leaf-1' },
        reason: 'tidy up'
      })
    ).rejects.toThrow(/that needs the person/)
    expect(requestSessionFolders).not.toHaveBeenCalled()
    expect(trail()).toEqual([])
  })
})
