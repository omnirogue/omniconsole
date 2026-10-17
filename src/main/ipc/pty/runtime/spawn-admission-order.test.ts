import { beforeEach, describe, expect, it, vi } from 'vitest'

// Why: an agent start from the runtime controller (CLI, phone, orchestration) can wait minutes
// for an app-wide admission slot. The worktree terminal-install token is the worktree-removal
// fence, so it must be taken only once the start is admitted — a queued start must not stall a
// worktree deletion, nor land in a worktree that was removed while it waited.

const state = vi.hoisted(() => ({
  order: [] as string[],
  releaseGate: (() => {}) as () => void,
  gateArgs: [] as Record<string, unknown>[]
}))

vi.mock('../provider/registry', () => ({ localProvider: {} }))
vi.mock('../../../providers/local-pty-provider', () => ({ LocalPtyProvider: class {} }))
vi.mock('../delivery/spawn-geometry', () => ({
  beginPtySpawnGeometry: () => null,
  restorePtySpawnGeometry: () => {}
}))
vi.mock('../host-env/codex-home', () => ({ CODEX_HOME_ENV_KEYS: [] }))
vi.mock('../host-env/pi-agent', () => ({
  mergePtyEnvDeletions: (...lists: (string[] | undefined)[]) =>
    lists.flatMap((list) => list ?? []),
  removeCodexHomeDeletionRequests: (keys: string[] | undefined) => keys,
  getInheritedAgentHookEnvKeysToDelete: () => [],
  getInheritedClaudeSessionStampEnvKeysToDelete: () => []
}))
vi.mock('../host-env/path', () => ({
  promoteAgentTeamsShimPath: () => {},
  deleteRequestedEnvKeys: () => {}
}))
vi.mock('../host-env/fresh-spawn-routing', () => ({
  routesFreshSpawnsToLocalProvider: () => false,
  beginPtySpawnForWorktree: vi.fn(() => {
    state.order.push('install-token')
    return () => state.order.push('install-token-released')
  })
}))
vi.mock('../../../claude-accounts/environment', () => ({ CLAUDE_AUTH_ENV_VARS: [] }))
vi.mock('../../../pty/legacy-terminal-shim-dir', () => ({
  LEGACY_TERMINAL_SHIM_REMOTE_ENV_KEYS: []
}))
vi.mock('../pane/stable-owner', () => ({ resolveStablePaneOwner: () => null }))
vi.mock('../../terminal-startup-color-query-replies', () => ({
  getStartupTerminalColorQueryReplyColors: () => null
}))
vi.mock('../pane/resume-task-link', () => ({ carryResumedTaskForSpawn: async () => {} }))
vi.mock('./spawn-reply', () => ({ toRuntimeSpawnReply: (reply: unknown) => reply }))
vi.mock('./spawn-early', () => ({ adoptMaterializedRuntimePtySpawn: () => null }))
vi.mock('./spawn-preflight', () => ({
  prepareRuntimePtySpawn: async (ctx: { launchCommand?: string; cwd?: string }) => {
    ctx.launchCommand = 'codex resume thread-1'
    ctx.cwd = '/tmp/wt'
    return null
  }
}))
vi.mock('./spawn-execute', () => ({
  executeRuntimePtySpawn: async () => {
    state.order.push('execute')
  }
}))
vi.mock('./spawn-commit', () => ({ commitRuntimePtySpawn: async () => ({ id: 'pty-1' }) }))
vi.mock('../../../pty/hub-task-launch-admission', () => ({
  assertUnboundHubTerminalLaunch: () => {}
}))
vi.mock('../pane/launch-authority', () => ({ getDeclaredLaunchHubTaskId: () => undefined }))
vi.mock('../../../runtime/new-agent-session-command-defaults', () => ({
  resolveNewAgentSessionCommandDefaults: async (args: { command?: string }) => args.command
}))
vi.mock('../agent-launch-admission-gate', () => ({
  isLivePtyReattach: () => false,
  gatePtySpawnAgentLaunch: (args: Record<string, unknown>) =>
    new Promise<void>((resolve) => {
      state.gateArgs.push(args)
      state.order.push('queued')
      state.releaseGate = () => {
        state.order.push('admitted')
        resolve()
      }
    })
}))

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve()
  }
}

describe('runtime controller agent start admission order', () => {
  beforeEach(() => {
    state.order = []
    state.releaseGate = () => {}
    state.gateArgs = []
  })

  it('takes the worktree install token only after the start is admitted', async () => {
    const { spawnPtyFromRuntimeController } = await import('./spawn')
    const spawned = spawnPtyFromRuntimeController(
      { getSettings: () => ({ launchAdmissionPer10s: 3 }) } as never,
      {
        cols: 80,
        rows: 24,
        worktreeId: 'repo-1::/tmp/wt',
        launchAgent: 'codex',
        command: 'codex resume thread-1'
      }
    )
    await settle()
    // Still queued: nothing fences the worktree against removal.
    expect(state.order).toEqual(['queued'])

    state.releaseGate()
    await expect(spawned).resolves.toMatchObject({ id: 'pty-1' })
    expect(state.order).toEqual([
      'queued',
      'admitted',
      'install-token',
      'execute',
      'install-token-released'
    ])
  })

  it('queues CLI and orchestration starts in the explicit lane with their pane key', async () => {
    const { spawnPtyFromRuntimeController } = await import('./spawn')
    const onAgentLaunchQueued = vi.fn()
    const leafId = '11111111-1111-4111-8111-111111111111'
    void spawnPtyFromRuntimeController(
      { getSettings: () => ({ launchAdmissionPer10s: 3 }) } as never,
      {
        cols: 80,
        rows: 24,
        worktreeId: 'repo-1::/tmp/wt',
        tabId: 'tab-cli',
        leafId,
        launchAgent: 'codex',
        command: 'codex resume thread-1',
        onAgentLaunchQueued
      }
    )
    await settle()
    expect(state.gateArgs[0]).toMatchObject({
      launchPriority: 'explicit',
      launchAdmissionKey: `tab-cli:${leafId}`,
      onQueued: onAgentLaunchQueued
    })
  })

  it("puts a phone's own create in the person lane", async () => {
    const { spawnPtyFromRuntimeController } = await import('./spawn')
    void spawnPtyFromRuntimeController(
      { getSettings: () => ({ launchAdmissionPer10s: 3 }) } as never,
      {
        cols: 80,
        rows: 24,
        worktreeId: 'repo-1::/tmp/wt',
        launchAgent: 'codex',
        command: 'codex',
        launchPriority: 'person'
      }
    )
    await settle()
    expect(state.gateArgs[0]).toMatchObject({ launchPriority: 'person' })
    expect(state.gateArgs[0]).not.toHaveProperty('launchAdmissionKey')
  })
})
