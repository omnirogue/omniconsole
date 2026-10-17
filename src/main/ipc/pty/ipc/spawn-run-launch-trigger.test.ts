import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { PtySpawnOptions } from '../../../providers/types'
import { _resetLaunchTriggerHintsForTests } from '../../../observability/launch-trigger-hints'
import type { PtyIpcSpawnState } from './spawn-state'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from './spawn-types'

const mocks = vi.hoisted(() => ({
  prepareInterruptedResume: vi.fn(),
  spawnOptions: [] as PtySpawnOptions[]
}))

vi.mock('./interrupted-resume', () => ({
  prepareInterruptedResume: mocks.prepareInterruptedResume
}))
vi.mock('./spawn-begin', () => ({ beginPtyIpcSpawn: vi.fn(async () => null) }))
vi.mock('./spawn-preflight', () => ({ preparePtyIpcSpawnPreflight: vi.fn(async () => {}) }))
vi.mock('./spawn-env', () => ({
  assemblePtyIpcSpawnEnv: vi.fn(async (ctx: PtyIpcSpawnState) => {
    ctx.launchCommand = ctx.args.command
  })
}))
vi.mock('./spawn-execute', () => ({ executePtyIpcSpawn: vi.fn(async () => {}) }))
vi.mock('./spawn-commit', () => ({
  commitPtyIpcSpawn: vi.fn(async (ctx: PtyIpcSpawnState) => {
    mocks.spawnOptions.push(ctx.spawnOptions)
    return { id: 'pty-1' }
  })
}))
vi.mock('../provider/registry', () => ({ localProvider: {} }))
vi.mock('../host-env/codex-home', () => ({
  CODEX_HOME_ENV_KEYS: ['CODEX_HOME', 'ORCA_CODEX_HOME']
}))
vi.mock('../host-env/codex-resume', () => ({
  noCodexResumeLaunch: (command: string | undefined) => ({
    codexResumeHome: null,
    command,
    notifyResumeUnavailable: false,
    droppedResumeArgv: false,
    providerSession: null
  })
}))
vi.mock('../../../runtime/new-agent-session-command-defaults', () => ({
  resolveNewAgentSessionCommandDefaults: vi.fn(async (input: { command?: string }) => input.command)
}))

import { runPtyIpcSpawn } from './spawn-run'

// What fresh-spawn-start sends for every cold-restore agent resume of a restored tab:
// interruptedRestore rides along whether or not the agent was mid-turn.
const coldRestoreResume: PtySpawnIpcArgs = {
  cols: 80,
  rows: 24,
  command: 'claude --resume abc',
  interruptedRestore: true,
  resumeProviderSession: { key: 'session_id', id: 'abc' },
  launchToken: 'launch-token',
  launchAgent: 'claude',
  launchTrigger: 'hibernation-wake',
  launchVisible: true
}

function deps(settings: Partial<GlobalSettings> = {}): PtySpawnIpcDeps {
  return { getSettings: () => settings as GlobalSettings } as unknown as PtySpawnIpcDeps
}

async function spawnedTrigger(
  args: PtySpawnIpcArgs,
  spawnDeps: PtySpawnIpcDeps = deps()
): Promise<unknown> {
  mocks.spawnOptions.length = 0
  await runPtyIpcSpawn(spawnDeps, args)
  expect(mocks.prepareInterruptedResume).toHaveBeenCalledWith(spawnDeps, args)
  return mocks.spawnOptions[0]?.launchTrigger
}

beforeEach(() => {
  _resetLaunchTriggerHintsForTests()
  mocks.prepareInterruptedResume.mockReset()
})

afterEach(() => {
  _resetLaunchTriggerHintsForTests()
})

describe('runPtyIpcSpawn launch trigger (latency telemetry)', () => {
  it('records renderer operation when no auto-continue armed', async () => {
    mocks.prepareInterruptedResume.mockReturnValue(null)
    expect(await spawnedTrigger(coldRestoreResume)).toBe('renderer-spawn')
    expect(await spawnedTrigger({ ...coldRestoreResume, launchTrigger: 'person-reveal' })).toBe(
      'renderer-spawn'
    )
    expect(
      await spawnedTrigger({ ...coldRestoreResume, launchTrigger: 'cold-restore-mount' })
    ).toBe('renderer-spawn')
  })

  it('labels the spawn restore-interrupted when main armed the auto-continue', async () => {
    const continuation = { commit: vi.fn(), dispose: vi.fn() }
    mocks.prepareInterruptedResume.mockReturnValue(continuation)
    expect(await spawnedTrigger({ ...coldRestoreResume, launchTrigger: 'background-mount' })).toBe(
      'restore-interrupted'
    )
    expect(continuation.commit).toHaveBeenCalledWith('pty-1', true)
  })

  it('does not claim restore-interrupted while auto-continue is switched off', async () => {
    mocks.prepareInterruptedResume.mockReturnValue({ commit: vi.fn(), dispose: vi.fn() })
    expect(
      await spawnedTrigger(
        { ...coldRestoreResume, launchTrigger: 'background-mount' },
        deps({ autoContinueInterruptedSessions: false })
      )
    ).toBe('renderer-spawn')
  })
})
