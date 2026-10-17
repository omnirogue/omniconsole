import { normalizeLaunchCause, type LaunchCause } from '../../shared/launch-cause'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { TurnSignal } from '../next-steps/next-step-turn-signal'
import type { RpcContext } from '../runtime/rpc/core'
import { prepareSessionAction } from '../runtime/rpc/methods/session-manage-support'
import {
  connectRegisteredSshTarget,
  getRegisteredSshState,
  listRegisteredSshTargets
} from '../ssh/ssh-target-registry'
import { SessionManagePartialError } from './session-manage-refusal'
import type { TransferSession } from './session-manage-transfer-contract'
import { transferSession } from './session-manage-transfer-fixtures'
import type { HostMovePlan } from './session-transfer-host-contract'
import { readTransferSourceWork, runtimeTransferHostDeps } from './session-transfer-host-runtime'

const signals = vi.hoisted(() => ({
  order: [] as string[],
  listener: null as ((signal: TurnSignal) => void) | null
}))
vi.mock('../ssh/ssh-target-registry', () => ({
  getRegisteredSshState: vi.fn(),
  listRegisteredSshTargets: vi.fn(),
  connectRegisteredSshTarget: vi.fn()
}))
vi.mock('../runtime/rpc/methods/session-manage-support', () => ({
  prepareSessionAction: vi.fn(),
  recordSessionAction: vi.fn()
}))
vi.mock('./session-manage-runtime-actions', () => ({ readSidebarRows: vi.fn(async () => []) }))
vi.mock('../next-steps/next-step-suggestion-slot', () => ({
  onNextStepTurnSignal: vi.fn((listener: (signal: TurnSignal) => void) => {
    signals.order.push('subscribe')
    signals.listener = listener
    return () => {
      signals.listener = null
    }
  })
}))

const HOST = 'ssh:mw0002' as const
const identity = {
  canonicalKey: 'github.com/omnirogue/omni-ide',
  remoteName: 'origin',
  remoteUrl: 'git@github.com:omnirogue/omni-ide.git'
}
const repos = [
  { id: 'repo', path: '/w', displayName: 'omni-ide', gitRemoteIdentity: identity },
  {
    id: 'host-repo',
    path: '/work/main',
    displayName: 'omni-ide',
    connectionId: 'mw0002',
    gitRemoteIdentity: identity
  }
] as Repo[]
const plan: HostMovePlan = {
  hostId: HOST,
  label: 'mw0002',
  workspace: {
    id: 'host-repo::/work/parser',
    path: '/work/parser',
    branch: 'feat/parser',
    name: 'p'
  },
  works: []
}

function gitStatus(overrides: Record<string, unknown> = {}) {
  return {
    entries: [],
    conflictOperation: 'unknown',
    head: 'abc123',
    branch: 'refs/heads/feat/parser',
    upstreamStatus: { hasUpstream: true, upstreamName: 'origin/feat/parser', ahead: 0, behind: 0 },
    ...overrides
  }
}

function runtimeFixture() {
  let paneKey = ''
  return {
    paneKey: () => paneKey,
    getRuntimeGitStatus: vi.fn(async () => gitStatus()),
    getRuntimeGitUpstreamStatus: vi.fn(async () => ({
      hasUpstream: true,
      upstreamName: 'origin/feat/parser',
      ahead: 0,
      behind: 0
    })),
    listRepos: vi.fn(() => repos),
    listManagedWorktrees: vi.fn(async () => ({
      worktrees: [
        {
          id: 'host-repo::/work/parser',
          repoId: 'host-repo',
          path: '/work/parser',
          branch: 'refs/heads/feat/parser',
          displayName: 'parser'
        }
      ],
      totalCount: 1,
      truncated: false
    })),
    showManagedTerminalWorkspace: vi.fn(),
    requestSessionFolders: vi.fn(),
    getStatus: vi.fn(() => ({ runtimeId: 'runtime-1' })),
    getTerminalPaneKey: vi.fn(() => paneKey),
    renameTerminal: vi.fn(async () => ({})),
    createAgentSession: vi.fn(
      async (
        request: {
          placement: { tabId: string; leafId: string }
          worktree: string
          clientOperationId: string
        },
        _caller?: { launchCause: LaunchCause }
      ) => {
        signals.order.push('spawn')
        paneKey = makePaneKey(request.placement.tabId, request.placement.leafId)
        return {
          terminal: { handle: 'term_new', worktreeId: request.worktree.slice(3), title: null },
          disposition: 'created'
        }
      }
    )
  }
}

function hostDeps(runtime: object) {
  const journal = vi.fn(async () => {
    signals.order.push('journal')
  })
  const capture = vi.fn()
  const deps = runtimeTransferHostDeps({
    context: { runtime } as unknown as RpcContext,
    journal,
    capture
  })
  return { deps, journal, capture }
}

function listed(paneKey: string): TransferSession {
  const session = transferSession(paneKey, {
    worktreeId: plan.workspace.id,
    terminal: 'term_new',
    hostId: HOST
  })
  return { ...session, row: { ...session.row, hostId: HOST } }
}

beforeEach(() => {
  signals.order = []
  signals.listener = null
  vi.mocked(listRegisteredSshTargets).mockReturnValue([
    { id: 'mw0002', label: 'mw0002' } as ReturnType<typeof listRegisteredSshTargets>[number]
  ])
  vi.mocked(getRegisteredSshState).mockReturnValue({ status: 'connected' } as ReturnType<
    typeof getRegisteredSshState
  >)
})

describe('reading a source’s work before a move', () => {
  const source = transferSession('source')

  it('takes the ahead count from the effective upstream reader, not the status projection', async () => {
    const runtime = runtimeFixture()
    runtime.getRuntimeGitUpstreamStatus.mockResolvedValueOnce({
      hasUpstream: true,
      upstreamName: 'origin/feat/parser',
      ahead: 2,
      behind: 0
    })
    runtime.getRuntimeGitStatus.mockResolvedValueOnce(
      gitStatus({ entries: [{ path: 'a.ts' }, { path: 'b.ts' }] })
    )
    expect(await readTransferSourceWork(runtime as never, source)).toEqual({
      kind: 'git',
      path: '/w',
      branch: 'feat/parser',
      head: 'abc123',
      upstream: { name: 'origin/feat/parser', ahead: 2 },
      uncommitted: 2
    })
    expect(runtime.getRuntimeGitStatus).toHaveBeenCalledWith(`id:${source.entry.worktreeId}`, {
      admissionTier: 'interactive',
      includeLineStats: false
    })
  })

  it('reports never pushed, unreadable and folder work without guessing', async () => {
    const runtime = runtimeFixture()
    runtime.getRuntimeGitUpstreamStatus.mockResolvedValueOnce({
      hasUpstream: false,
      upstreamName: undefined as unknown as string,
      ahead: 0,
      behind: 0
    })
    expect(await readTransferSourceWork(runtime as never, source)).toMatchObject({
      upstream: 'none'
    })
    runtime.getRuntimeGitUpstreamStatus.mockRejectedValueOnce(new Error('unknown revision'))
    expect(await readTransferSourceWork(runtime as never, source)).toMatchObject({
      upstream: 'unknown'
    })
    runtime.getRuntimeGitStatus.mockResolvedValueOnce(
      gitStatus({ branch: undefined, upstreamStatus: undefined })
    )
    expect(await readTransferSourceWork(runtime as never, source)).toMatchObject({
      branch: null,
      upstream: 'unknown'
    })
    const folder = { ...source, row: { ...source.row, workspaceKind: 'folder' as const } }
    runtime.getRuntimeGitStatus.mockClear()
    expect(await readTransferSourceWork(runtime as never, folder)).toEqual({
      kind: 'folder',
      path: '/w'
    })
    expect(runtime.getRuntimeGitStatus).not.toHaveBeenCalled()
  })
})

describe('planning a move on the host', () => {
  it('refuses an unreachable host as unverifiable before reading anything', async () => {
    vi.mocked(getRegisteredSshState).mockReturnValue({ status: 'disconnected' } as ReturnType<
      typeof getRegisteredSshState
    >)
    const runtime = runtimeFixture()
    const { deps } = hostDeps(runtime)
    await expect(deps.plan([transferSession('source')], { hostId: HOST })).rejects.toThrow(
      'mw0002 (ssh:mw0002) is not connected, so this computer cannot verify anything there (unverifiable). Nothing was asked, started or archived.'
    )
    expect(deps.reachable(HOST)).toBe(false)
    expect(runtime.getRuntimeGitStatus).not.toHaveBeenCalled()
    expect(runtime.listManagedWorktrees).not.toHaveBeenCalled()
    expect(connectRegisteredSshTarget).not.toHaveBeenCalled()
  })

  it('refuses a host this computer does not have', async () => {
    vi.mocked(listRegisteredSshTargets).mockReturnValue([])
    const { deps } = hostDeps(runtimeFixture())
    await expect(deps.plan([transferSession('source')], { hostId: HOST })).rejects.toThrow(
      'No SSH host ssh:mw0002 is set up on this computer'
    )
  })

  it('refuses a source on a detached HEAD before looking for a workspace', async () => {
    const runtime = runtimeFixture()
    runtime.getRuntimeGitStatus.mockResolvedValueOnce(gitStatus({ branch: undefined }))
    const { deps } = hostDeps(runtime)
    await expect(deps.plan([transferSession('source')], { hostId: HOST })).rejects.toThrow(
      '“source” is not on a branch'
    )
    expect(runtime.listManagedWorktrees).not.toHaveBeenCalled()
  })

  it('finds the workspace of the same repository with the source branch on that host', async () => {
    const { deps } = hostDeps(runtimeFixture())
    const source = transferSession('source')
    const moved = await deps.plan([{ ...source, row: { ...source.row, repoId: 'repo' } }], {
      hostId: HOST
    })
    expect(moved).toMatchObject({
      hostId: HOST,
      label: 'mw0002',
      workspace: { id: 'host-repo::/work/parser', path: '/work/parser', branch: 'feat/parser' },
      works: [{ kind: 'git', branch: 'feat/parser', upstream: { name: 'origin/feat/parser' } }]
    })
  })
})

describe('starting the target on the host', () => {
  it('listens before the spawn, launches through createAgentSession and ties the reply', async () => {
    const runtime = runtimeFixture()
    vi.mocked(prepareSessionAction).mockImplementation(
      async (_context, target) => listed(target.paneKey!) as never
    )
    const { deps, journal, capture } = hostDeps(runtime)
    const source = transferSession('source')
    const { target, pending } = await deps.launch(plan, source, 'source (continued)', 'The brief.')
    expect(signals.order).toEqual(['journal', 'subscribe', 'spawn'])
    expect(journal).toHaveBeenCalledWith(
      'session.create',
      expect.objectContaining({ row: expect.objectContaining({ hostId: HOST }) }),
      expect.objectContaining({ host: HOST, worktreeId: plan.workspace.id, state: 'pending' })
    )
    const request = runtime.createAgentSession.mock.calls[0][0]
    expect(request).toMatchObject({
      worktree: 'id:host-repo::/work/parser',
      agent: 'claude',
      promptDelivery: 'auto-submit',
      presentation: 'background',
      revealInSidebar: true,
      viewMode: 'terminal',
      sshAccountSelection: {
        policy: 'best-verified',
        expectedHostId: HOST,
        expectedRuntimeId: 'runtime-1'
      }
    })
    expect(pending.sent).toMatch(/^\[Brief b-[0-9a-f-]{36}\] The brief\.\n\n/)
    const cause = normalizeLaunchCause(runtime.createAgentSession.mock.calls[0][1]?.launchCause)
    expect(cause.trigger).toBe('session-transfer')
    expect(cause.reference?.transferId).toMatch(/^[0-9a-f-]{36}$/)
    expect(cause.reference?.transferId).toBe(
      pending.sent.match(/^\[Brief b-([0-9a-f-]{36})\]/)?.[1]
    )
    expect(cause.requestId).toBe(request.clientOperationId)
    expect(runtime.createAgentSession).toHaveBeenCalledOnce()

    expect(pending.sent).toContain(pending.acknowledgement!)
    expect(runtime.renameTerminal).toHaveBeenCalledWith('term_new', 'source (continued)')
    expect(target.entry.paneKey).toBe(runtime.paneKey())
    signals.listener!({
      kind: 'finished',
      turn: {
        conversation: { kind: 'pty', paneKey: runtime.paneKey(), worktreeId: plan.workspace.id },
        turnKey: 'turn-1',
        completedAt: 1,
        lastUserPrompt: pending.sent,
        lastAssistantMessage: pending.acknowledgement!,
        replyComplete: true
      }
    } as TurnSignal)
    await expect(pending.wait).resolves.toMatchObject({
      outcome: 'answered',
      reply: pending.acknowledgement
    })
    expect(capture).toHaveBeenCalledWith(target, expect.objectContaining({ turnKey: 'turn-1' }))
  })

  it('reports an uncertain launch as possibly started, and a refusal before spawn as nothing', async () => {
    const runtime = runtimeFixture()
    runtime.createAgentSession.mockRejectedValueOnce(
      Object.assign(new Error('relay lost'), { agentSessionOperationOutcome: 'unknown' })
    )
    const { deps } = hostDeps(runtime)
    const source = transferSession('source')
    const uncertain = deps.launch(plan, source, 'T', 'brief')
    await expect(uncertain).rejects.toBeInstanceOf(SessionManagePartialError)
    await expect(uncertain).rejects.toThrow('may have started a session on mw0002 (ssh:mw0002)')
    runtime.createAgentSession.mockRejectedValueOnce(
      new Error('The launch workspace is not on the requested SSH host. Nothing launched.')
    )
    const refused = deps.launch(plan, source, 'T', 'brief')
    await expect(refused).rejects.toThrow('Nothing launched.')
    await expect(refused).rejects.not.toBeInstanceOf(SessionManagePartialError)
  })

  it('never reaches a provisioning, recipe, rent or connect path', async () => {
    const touched = new Set<string>()
    const runtime = new Proxy(runtimeFixture(), {
      get(target, key, receiver) {
        touched.add(String(key))
        return Reflect.get(target, key, receiver)
      }
    })
    vi.mocked(prepareSessionAction).mockImplementation(
      async (_context, target) => listed(target.paneKey!) as never
    )
    const { deps } = hostDeps(runtime)
    const source = transferSession('source')
    const moved = await deps.plan([{ ...source, row: { ...source.row, repoId: 'repo' } }], {
      hostId: HOST
    })
    await deps.launch(moved, source, 'T', 'brief')
    expect(
      [...touched].filter((key) => /vm|recipe|provision|ephemeral|rent|connect/i.test(key))
    ).toEqual([])
    expect(
      [...touched].filter((key) => /^(create|remove|delete|write|set|start)/i.test(key))
    ).toEqual(['createAgentSession'])
    expect(connectRegisteredSshTarget).not.toHaveBeenCalled()
  })

  it('no module on the move path imports or calls a VM, recipe or provisioning path', () => {
    const files = [
      'session-transfer-host.ts',
      'session-transfer-host-contract.ts',
      'session-transfer-host-launch.ts',
      'session-transfer-host-runtime.ts',
      'session-transfer-host-workspace.ts',
      'session-manage-transfer.ts',
      'session-manage-transfer-runtime.ts',
      '../runtime/rpc/methods/session-manage-transfer-methods.ts',
      '../../cli/handlers/session-transfer.ts'
    ]
    for (const file of files) {
      const text = readFileSync(join(__dirname, file), 'utf8')
      const imports = [...text.matchAll(/from '([^']+)'/g)].map((match) => match[1])
      expect(imports.filter((path) => /vm|recipe|provision|ephemeral/i.test(path))).toEqual([])
      expect(text).not.toMatch(/['"`](?:vm|ephemeralVm|environmentRecipe|projectHostSetup)[.:]/)
    }
  })
})
