import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionFolderRendererRequest } from '../../../../shared/session-folder-cli'
import type { SessionManageSidebarRow } from '../../../../shared/session-manage-relay'
import type { SessionManageActor } from '../../../../shared/session-manage-types'
import { SESSION_ACTIONS_FILE } from '../../../session-manage/session-actions-log'
import type * as SessionManageInventoryModule from '../../../session-manage/session-manage-inventory'
import { manageEntry, sidebarRow } from '../../../session-manage/session-manage-test-fixtures'
import { sessionOrganizationLedgerFor } from '../../../session-organization/organization-change-ledger'
import { ORGANIZATION_MOVE_NEEDS_REASON } from '../../../session-organization/organization-relayed-mutation'
import type { RpcContext } from '../core'

const state = vi.hoisted(() => ({
  dir: '',
  actor: { kind: 'cli' } as SessionManageActor,
  archiveRemote: vi.fn(async () => ({ kind: 'completed' as const })),
  answerWait: vi.fn((_origin: string | null, _row: unknown): string | null => null)
}))

vi.mock('../../../omni-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => state.dir
}))
vi.mock('./session-manage-support', () => ({ actorFor: () => state.actor }))
// Why: a delete re-observes its row; these tests decide only who may be deleted (step 7).
vi.mock('../../../session-manage/session-manage-observe', () => ({
  observeSession: vi.fn(async () => ({}))
}))
vi.mock('../../../session-manage/session-manage-runtime-sources', () => ({
  createRuntimeObserveSources: vi.fn(() => ({}))
}))
vi.mock('../../../session-manage/session-manage-workflow-runtime', () => ({
  withRuntimeWorkflowRuns: vi.fn((sources: unknown) => sources)
}))
vi.mock('../../../session-manage/session-manage-inventory', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionManageInventoryModule>()),
  toSessionManageEntry: vi.fn(() => manageEntry())
}))
vi.mock('../../../session-host-remote/remote-session-archive', () => ({
  archiveRemoteSession: state.archiveRemote
}))
vi.mock('../../../answer-delivery/answer-wait', () => ({
  agentAnswerWaitRefusal: state.answerWait
}))

const {
  assertLocalSessionFolderCaller,
  mutateSessionFolders,
  SESSION_FOLDER_LAUNCH_MOVES_ONLY,
  SESSION_FOLDERS_LOCAL_ONLY_ERROR
} = await import('./session-folders')

function context(extra: Partial<RpcContext>): RpcContext {
  return { runtime: {} as RpcContext['runtime'], ...extra }
}

/** The window: answers a move with the organization outcome, as a current window does. */
function windowRuntime() {
  const requests: SessionFolderRendererRequest[] = []
  const requestSessionFolders = vi.fn(async (request: SessionFolderRendererRequest) => {
    requests.push(request)
    if (request.kind !== 'mutate') {
      return {}
    }
    return {
      summary: request.dryRun ? 'Would move' : 'Moved “Ads” into “Checkout”',
      sessionKey: 'k1',
      ...(request.change
        ? {
            organization: {
              opId: request.change.opId,
              targets: [{ sessionKey: 'k1', paneKey: 'tab-1:leaf-1' }],
              value: 'folder-checkout',
              before: [null],
              after: ['folder-checkout']
            }
          }
        : {})
    }
  })
  return {
    requests,
    ctx: { runtime: { requestSessionFolders } as unknown as RpcContext['runtime'] }
  }
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

const MOVE = {
  kind: 'moveSession' as const,
  paneKey: 'tab-1:leaf-1',
  destination: 'folder' as const,
  folder: 'Checkout'
}

beforeEach(() => {
  state.dir = mkdtempSync(join(tmpdir(), 'session-folders-rpc-'))
  state.actor = { kind: 'pane', paneKey: 'tab-9:leaf-9', title: 'Ads review' }
})

afterEach(async () => {
  // Why: the organization ledger saves history in the background; a save still running when the
  // folder is removed makes rmSync fail with ENOTEMPTY.
  await sessionOrganizationLedgerFor(state.dir).flush()
  rmSync(state.dir, { recursive: true, force: true })
})

describe('session folder RPC caller gate', () => {
  it('admits the local socket', () => {
    expect(() => assertLocalSessionFolderCaller(context({}))).not.toThrow()
  })

  it('refuses a paired device or remote client', () => {
    for (const extra of [
      { pairedDeviceId: 'device' },
      { clientId: 'client' },
      { clientKind: 'mobile' as const },
      { clientKind: 'runtime' as const }
    ]) {
      expect(() => assertLocalSessionFolderCaller(context(extra))).toThrow(
        SESSION_FOLDERS_LOCAL_ONLY_ERROR
      )
    }
  })
})

describe('sessionFolders.mutate records every change', () => {
  it('refuses an agent’s move without --reason, before anything reaches the window', async () => {
    const { requests, ctx } = windowRuntime()
    await expect(mutateSessionFolders(ctx, { op: MOVE })).rejects.toThrow(
      ORGANIZATION_MOVE_NEEDS_REASON
    )
    state.actor = { kind: 'cli' }
    await expect(
      mutateSessionFolders(ctx, { op: { kind: 'moveFolder', folder: 'Sales', into: 'Clients' } })
    ).rejects.toThrow(ORGANIZATION_MOVE_NEEDS_REASON)
    expect(requests).toEqual([])
    expect(trail()).toEqual([])
  })

  it('records an agent move with a reason as prepared → applied, with its opId and reason', async () => {
    const { requests, ctx } = windowRuntime()
    const result = await mutateSessionFolders(ctx, {
      op: MOVE,
      reason: 'checkout work',
      request: 'file the checkout session'
    })
    const opId = result.opId!
    expect(opId).toMatch(/^[0-9a-f-]{36}$/)
    expect(requests[0]).toEqual({
      kind: 'mutate',
      op: MOVE,
      change: {
        opId,
        executor: { kind: 'pane', paneKey: 'tab-9:leaf-9', title: 'Ads review' },
        reason: 'checkout work',
        request: 'file the checkout session'
      }
    })
    const actor = { paneKey: 'tab-9:leaf-9', title: 'Ads review' }
    expect(trail().map((line) => [line.phase, line.opId, line.reason, line.actor])).toEqual([
      ['prepared', opId, 'checkout work', actor],
      ['applied', opId, 'checkout work', actor]
    ])
    expect(result).not.toHaveProperty('organization')
  })

  it('lets a dry run through without a reason and records nothing', async () => {
    const { requests, ctx } = windowRuntime()
    await expect(mutateSessionFolders(ctx, { op: MOVE, dryRun: true })).resolves.toMatchObject({
      summary: 'Would move'
    })
    expect(requests).toEqual([{ kind: 'mutate', op: MOVE, dryRun: true }])
    expect(trail()).toEqual([])
  })

  it('records launch filing under launch with its built-in reason', async () => {
    const { requests, ctx } = windowRuntime()
    state.actor = { kind: 'cli' }
    await mutateSessionFolders(ctx, { op: MOVE, launch: 'terminal-create' })
    const launch = { kind: 'launch', source: 'terminal-create' }
    expect(requests[0]).toMatchObject({
      change: { executor: launch, reason: 'filed at launch' }
    })
    // The proven actor that claimed launch stays on the line beside the executor.
    expect(trail().map((line) => [line.phase, line.executor, line.reason, line.actor])).toEqual([
      ['prepared', launch, 'filed at launch', 'cli'],
      ['applied', launch, 'filed at launch', 'cli']
    ])
    await expect(
      mutateSessionFolders(ctx, {
        op: { kind: 'deleteFolder', folder: 'Old' },
        launch: 'session-launch'
      })
    ).rejects.toThrow(SESSION_FOLDER_LAUNCH_MOVES_ONLY)
  })
})

// Session parity, step 7 (C4): a row a paired computer runs and lists in its conversation ledger
// is never deleted here, `--unverified` and `--force` included; receiver-only captures and this
// computer's own rows keep today's delete, and owner-routed archive keeps working (F13).
describe('sessionFolders.mutate delete of a paired owner’s conversation', () => {
  const OWNER = '1d045bce-9849-4ceb-94b6-3e36aeca3513'
  const LEAF = 'cf50cc26-0360-45ed-9a19-3f94e3d56068'
  const ownerListed = sidebarRow({
    rowKey: JSON.stringify([`runtime:${OWNER}`, 'repo::/w', `web-terminal-host:${LEAF}`]),
    viewKey: 'owner-listed',
    hostId: `runtime:${OWNER}`,
    paneKey: `web-terminal-host:${LEAF}`,
    tabId: 'web-terminal-host',
    title: 'Owner live',
    mirroredConversationOwner: OWNER
  })
  const capture = sidebarRow({
    viewKey: 'capture',
    hostId: `runtime:${OWNER}`,
    paneKey: `web-terminal-closed:${LEAF}`,
    tabId: null,
    title: 'Closed on the owner',
    recordOnlyMirror: true
  })

  /** The window: lists `rows`, and applies a delete or archive as a current window does. */
  function rowsRuntime(rows: SessionManageSidebarRow[]) {
    const requests: string[] = []
    // Why a wide request: the sidebar rows ride the same relay as the folder mutations.
    const requestSessionFolders = vi.fn(
      async (request: { kind: string; change?: { opId: string } }) => {
        requests.push(request.kind)
        if (request.kind === 'listSessions') {
          return rows
        }
        if (request.kind !== 'mutate') {
          return {}
        }
        return {
          summary: 'Deleted',
          sessionKey: rows[0]!.viewKey,
          ...(request.change
            ? {
                organization: {
                  opId: request.change.opId,
                  targets: [{ sessionKey: rows[0]!.viewKey, paneKey: rows[0]!.paneKey }],
                  value: true,
                  before: [false],
                  after: [true]
                }
              }
            : {})
        }
      }
    )
    return {
      kinds: () => [...requests],
      ctx: {
        runtime: {
          requestSessionFolders,
          getArtifactApiOrigin: () => 'https://omni.example'
        } as unknown as RpcContext['runtime']
      }
    }
  }

  const deleteOp = (row: SessionManageSidebarRow, extra: Record<string, boolean> = {}) => ({
    op: { kind: 'deleteSession' as const, paneKey: row.paneKey!, ...extra },
    request: 'delete that one'
  })

  beforeEach(() => {
    state.actor = { kind: 'cli' }
    state.archiveRemote.mockClear()
    state.answerWait.mockReset().mockReturnValue(null)
  })

  it('refuses a delete while a decision waits on the session, --force included', async () => {
    const own = sidebarRow({ viewKey: 'own', providerSessionId: 'conv-1' })
    const refusal =
      'Kept: a decision is still waiting on this session (plan.md); only the person can delete it. Nothing changed.'
    state.answerWait.mockReturnValue(refusal)
    const { kinds, ctx } = rowsRuntime([own])
    await expect(mutateSessionFolders(ctx, deleteOp(own, { force: true }))).rejects.toThrow(refusal)
    expect(kinds()).toEqual(['listSessions'])
    expect(state.answerWait).toHaveBeenCalledWith(
      'https://omni.example',
      expect.objectContaining({ paneKey: own.paneKey, providerSessionId: 'conv-1' })
    )
  })

  it('refuses an owner-listed row even with --unverified and --force; nothing reaches the window', async () => {
    const { kinds, ctx } = rowsRuntime([ownerListed])
    await expect(
      mutateSessionFolders(ctx, deleteOp(ownerListed, { unverified: true, force: true }))
    ).rejects.toThrow('which lists it, so it was not deleted here (--unverified included)')
    expect(kinds()).toEqual(['listSessions'])
  })

  it('still lets the person drop a receiver-only capture with --unverified', async () => {
    const { kinds, ctx } = rowsRuntime([capture])
    await expect(
      mutateSessionFolders(ctx, deleteOp(capture, { unverified: true }))
    ).resolves.toMatchObject({ summary: 'Deleted' })
    expect(kinds()).toContain('mutate')
  })

  // evidence/sidebar-counts-macbook-0725.json: a MacBook record of a Studio pane, re-keyed onto a
  // plain-UUID tab (C4). Step 6 flags it record-only (or vouched once the owner's ledger names it).
  const C4_PANE = '4c3e6035-ce3a-41cd-a874-7d9d1341abb2:0d3bfdb5-fb72-4fa7-8335-4099f5857ebb'
  const plainCapture = (vouched: boolean) =>
    sidebarRow({
      viewKey: 'plain-capture',
      hostId: `runtime:${OWNER}`,
      paneKey: C4_PANE,
      tabId: null,
      title: 'Advertising check',
      ...(vouched ? { mirroredConversationOwner: OWNER } : { recordOnlyMirror: true })
    })

  it('drops a plain-UUID capture under a paired runtime only with --unverified (C4)', async () => {
    const row = plainCapture(false)
    const { kinds, ctx } = rowsRuntime([row])
    await expect(mutateSessionFolders(ctx, deleteOp(row))).rejects.toThrow(
      "only this computer's saved record"
    )
    expect(kinds()).toEqual(['listSessions'])
    await expect(
      mutateSessionFolders(ctx, deleteOp(row, { unverified: true }))
    ).resolves.toMatchObject({ summary: 'Deleted' })
    expect(kinds()).toContain('mutate')
  })

  it('refuses that capture once its owner vouches for it, --unverified included', async () => {
    const row = plainCapture(true)
    const { kinds, ctx } = rowsRuntime([row])
    await expect(mutateSessionFolders(ctx, deleteOp(row, { unverified: true }))).rejects.toThrow(
      'which lists it, so it was not deleted here (--unverified included)'
    )
    expect(kinds()).toEqual(['listSessions'])
  })

  it("deletes this computer's own row as before", async () => {
    const own = sidebarRow({ viewKey: 'own' })
    const { kinds, ctx } = rowsRuntime([own])
    await expect(mutateSessionFolders(ctx, deleteOp(own))).resolves.toMatchObject({
      summary: 'Deleted'
    })
    expect(kinds()).toContain('mutate')
  })

  it('keeps owner-routed archive for a mirrored tab row its owner lists (F13)', async () => {
    const { ctx } = rowsRuntime([ownerListed])
    await expect(
      mutateSessionFolders(ctx, {
        op: { kind: 'archiveSession', paneKey: ownerListed.paneKey!, archived: true }
      })
    ).resolves.toMatchObject({
      sessionKey: 'owner-listed',
      summary: 'The owning computer confirmed archive of “Owner live”.'
    })
    expect(state.archiveRemote).toHaveBeenCalledOnce()
  })
})
