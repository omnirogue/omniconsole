import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { PtyIpcSpawnState } from './spawn-state'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from './spawn-types'

const mocks = vi.hoisted(() => ({
  resolveDefaults: vi.fn(async (input: { command?: string }) => input.command)
}))

vi.mock('./interrupted-resume', () => ({ prepareInterruptedResume: vi.fn(() => null) }))
vi.mock('./spawn-begin', () => ({ beginPtyIpcSpawn: vi.fn(async () => null) }))
vi.mock('./spawn-preflight', () => ({
  preparePtyIpcSpawnPreflight: vi.fn(async (ctx: PtyIpcSpawnState) => {
    ctx.cwd = '/repo'
  })
}))
vi.mock('./spawn-env', () => ({
  assemblePtyIpcSpawnEnv: vi.fn(async (ctx: PtyIpcSpawnState) => {
    ctx.launchCommand = ctx.args.command
  })
}))
vi.mock('./spawn-execute', () => ({ executePtyIpcSpawn: vi.fn(async () => {}) }))
vi.mock('./spawn-commit', () => ({ commitPtyIpcSpawn: vi.fn(async () => ({ id: 'pty-1' })) }))
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
  resolveNewAgentSessionCommandDefaults: mocks.resolveDefaults
}))

import { runPtyIpcSpawn } from './spawn-run'

const resume: PtySpawnIpcArgs = {
  cols: 80,
  rows: 24,
  command: "claude '--resume' 'abc' 'Go'",
  resumeProviderSession: { key: 'session_id', id: 'abc' },
  launchToken: 'launch-token',
  launchAgent: 'claude',
  launchVisible: false
}
const deps = { getSettings: () => ({}) as GlobalSettings } as unknown as PtySpawnIpcDeps

beforeEach(() => {
  mocks.resolveDefaults.mockClear()
})

describe('runPtyIpcSpawn new-session defaults on a thread resume', () => {
  it("a routine's thread resume takes fresh-launch defaults", async () => {
    await runPtyIpcSpawn(deps, { ...resume, launchTrigger: 'automation' })
    expect(mocks.resolveDefaults).toHaveBeenCalledWith(
      expect.objectContaining({ continuation: false, threadResume: true })
    )
  })

  it('a person resuming a conversation, or a waking session, is still a continuation', async () => {
    await runPtyIpcSpawn(deps, { ...resume, launchTrigger: 'person-reveal' })
    await runPtyIpcSpawn(deps, {
      ...resume,
      launchTrigger: 'automation',
      interruptedRestore: true
    })
    expect(mocks.resolveDefaults.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({ continuation: true, threadResume: false }),
      expect.objectContaining({ continuation: true, threadResume: true })
    ])
  })
})
