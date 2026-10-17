import { beforeEach, describe, expect, it, vi } from 'vitest'

// Why: a routine resuming its recorded thread through the runtime controller (serve mode)
// must take the persisted model a fresh launch would; an adopted session must not.

const state = vi.hoisted(() => ({
  resolveDefaults: vi.fn(async (args: { command?: string }) => args.command),
  provider: { spawn: vi.fn(async (_options: unknown) => ({ id: 'pty-1' })) }
}))

vi.mock('../provider/registry', () => ({ localProvider: {} }))
vi.mock('../../../providers/local-pty-provider', () => ({ LocalPtyProvider: class {} }))
vi.mock('../delivery/spawn-geometry', () => ({
  beginPtySpawnGeometry: () => null,
  restorePtySpawnGeometry: () => {}
}))
vi.mock('../host-env/codex-home', () => ({ CODEX_HOME_ENV_KEYS: [] }))
vi.mock('../host-env/pi-agent', () => ({
  mergePtyEnvDeletions: (...lists: (string[] | undefined)[]) => lists.flatMap((list) => list ?? []),
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
  beginPtySpawnForWorktree: vi.fn(() => () => {})
}))
vi.mock('../../../claude-accounts/environment', () => ({ CLAUDE_AUTH_ENV_VARS: [] }))
vi.mock('../../../pty/legacy-terminal-shim-dir', () => ({
  LEGACY_TERMINAL_SHIM_REMOTE_ENV_KEYS: []
}))
vi.mock('../pane/stable-owner', () => ({
  resolveStablePaneOwner: () => null,
  spawnForStablePane: async ({
    provider,
    spawnOptions
  }: {
    provider: typeof state.provider
    spawnOptions: unknown
  }) => ({ result: await provider.spawn(spawnOptions as never), owner: null })
}))
vi.mock('../../terminal-startup-color-query-replies', () => ({
  getStartupTerminalColorQueryReplyColors: () => null
}))
vi.mock('../pane/resume-task-link', () => ({ carryResumedTaskForSpawn: async () => {} }))
vi.mock('./spawn-reply', () => ({ toRuntimeSpawnReply: (reply: unknown) => reply }))
vi.mock('./spawn-early', () => ({ adoptMaterializedRuntimePtySpawn: () => null }))
vi.mock('./spawn-preflight', () => ({
  prepareRuntimePtySpawn: async (ctx: {
    args: { command?: string }
    launchCommand?: string
    cwd?: string
    provider: unknown
  }) => {
    ctx.launchCommand = ctx.args.command
    ctx.cwd = '/tmp/wt'
    ctx.provider = state.provider
    return null
  }
}))
vi.mock('./spawn-execute', () => ({
  executeRuntimePtySpawn: async (ctx: { result: unknown; spawnOptions: unknown }) => {
    ctx.result = await state.provider.spawn(ctx.spawnOptions as never)
  }
}))
vi.mock('./spawn-commit', () => ({
  commitRuntimePtySpawn: async (ctx: { result: unknown }) => ctx.result
}))
vi.mock('../../../pty/hub-task-launch-admission', () => ({
  assertUnboundHubTerminalLaunch: () => {}
}))
vi.mock('../pane/launch-authority', () => ({ getDeclaredLaunchHubTaskId: () => undefined }))
vi.mock('../../../runtime/new-agent-session-command-defaults', () => ({
  resolveNewAgentSessionCommandDefaults: state.resolveDefaults
}))
vi.mock('../agent-launch-admission-gate', () => ({
  isLivePtyReattach: () => false,
  gatePtySpawnAgentLaunch: async () => {}
}))
import { spawnPtyFromRuntimeController } from './spawn'

beforeEach(() => {
  state.resolveDefaults.mockClear()
  state.provider.spawn.mockClear()
})

const resume = {
  cols: 80,
  rows: 24,
  worktreeId: 'folder:99999999-9999-4999-8999-999999999999',
  command: "claude '--resume' 'abc' 'Go'",
  launchAgent: 'claude',
  resumeProviderSession: { key: 'session_id', id: 'abc' }
}

async function spawn(extra: Record<string, unknown> = {}) {
  await spawnPtyFromRuntimeController(
    { getSettings: () => ({}) } as never,
    {
      ...resume,
      ...extra
    } as never
  )
  return state.resolveDefaults.mock.calls.at(-1)?.[0]
}

describe('runtime controller new-session defaults on a thread resume', () => {
  it("a routine's thread resume takes fresh-launch defaults", async () => {
    expect(
      await spawn({
        launchCause: {
          trigger: 'automation',
          reference: { automationId: 'a', automationRunId: 'r' }
        }
      })
    ).toEqual(expect.objectContaining({ continuation: false, threadResume: true }))
  })

  it('any other resume, and an adopted session, stay continuations', async () => {
    expect(await spawn()).toEqual(
      expect.objectContaining({ continuation: true, threadResume: false })
    )
    expect(
      await spawn({
        launchCause: {
          trigger: 'automation',
          reference: { automationId: 'a', automationRunId: 'r' }
        },
        adoptedStablePane: { tabId: 't', leafId: 'l' }
      })
    ).toEqual(expect.objectContaining({ continuation: true, threadResume: true }))
  })
})
