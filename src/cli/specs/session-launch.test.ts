import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_SESSION_EFFORT_ONLY_LAUNCH_RUNTIME_CAPABILITY,
  AGENT_SESSION_VERIFIED_ACCOUNT_LAUNCH_RUNTIME_CAPABILITY
} from '../../shared/protocol-version'
import { parseArgs, validateCommandAndFlags } from '../args'
import { RuntimeClientError, type RuntimeClient } from '../runtime-client'
import { SESSION_LAUNCH_HANDLERS } from '../handlers/session-launch'
import { readLaunchInput } from '../handlers/session-launch-input'
import { launchRecordFromPlan } from '../handlers/session-launch-send'
import { COMMAND_SPECS } from './index'
import { SESSION_LAUNCH_COMMAND_SPECS } from './session-launch'

vi.mock('../handlers/session-folders', () => ({
  fileNewTerminal: vi.fn(),
  resolveFolderForNewTerminal: vi.fn()
}))
vi.mock('../handlers/session-launch-placement', () => ({ runPlacedLaunch: vi.fn(async () => {}) }))
vi.mock('../handlers/session-launch-project', () => ({
  projectBriefForLaunch: vi.fn(async (_client: unknown, args: { prompt: string }) => ({
    prompt: args.prompt,
    report: null,
    warnings: [],
    items: []
  })),
  bindProjectLaunch: vi.fn(async () => null)
}))

const RUNTIME_ID = '11111111-1111-4111-8111-111111111111'
const ACCOUNT = {
  policy: 'best-verified',
  hostId: 'local',
  provider: 'codex',
  label: 'sal@example.com (pool slot-3)',
  choiceId: 'managed:a',
  remainingPercent: 71,
  boundBy: 'weekly',
  readingAt: 1_759_449_990_000,
  readingAgeMs: 10_400,
  fableVerified: false,
  verified: 3,
  considered: 4,
  excluded: [],
  why: 'most fresh verified headroom (71%, weekly) of 3 verified accounts'
}
const CONTRACT = {
  objective: 'Fix the login timeout',
  owner: 'Sal',
  host: 'this computer',
  branch: 'none',
  scope: 'src/auth',
  acceptance: 'pnpm test auth exits 0',
  evidence: 'REPORT.md'
}
let userData = ''
let cwd = ''

type HostAnswers = Record<string, (params: Record<string, unknown>) => unknown>

// The same host answers session-launch-contract.test.ts uses, cut to what a local launch reads.
function fakeHost(overrides: HostAnswers = {}) {
  const answers: HostAnswers = {
    'status.get': () => ({
      runtimeId: RUNTIME_ID,
      appVersion: '1.12.41',
      capabilities: [
        AGENT_SESSION_VERIFIED_ACCOUNT_LAUNCH_RUNTIME_CAPABILITY,
        AGENT_SESSION_EFFORT_ONLY_LAUNCH_RUNTIME_CAPABILITY
      ]
    }),
    'worktree.list': () => ({ worktrees: [{ id: `repo::${cwd}`, path: cwd }] }),
    'terminal.agentLaunchReadiness': (params) => ({
      runtimeId: RUNTIME_ID,
      workspace: { id: 'repo::/w', hostId: 'local', kind: 'git', path: '/w', name: 'w' },
      ...(params.preview ? { account: { verified: true, receipt: ACCOUNT } } : {})
    }),
    'terminal.createAgentSession': () => ({
      terminal: { handle: 'term_new', paneKey: 'tab:leaf', worktreeId: 'repo::/w', title: null },
      disposition: 'created',
      account: ACCOUNT,
      launch: { model: 'gpt-5.5', effort: 'xhigh', source: 'host-default' }
    }),
    ...overrides
  }
  const call = vi.fn(async (method: string, params?: unknown) => {
    const answer = answers[method]
    if (!answer) {
      throw new RuntimeClientError('method_not_found', `Unknown method: ${method}`)
    }
    return {
      id: 'r',
      ok: true,
      result: await answer((params ?? {}) as Record<string, unknown>),
      _meta: { runtimeId: RUNTIME_ID }
    }
  })
  return { call, client: { call, isRemote: false } as unknown as RuntimeClient }
}

type CallMock = ReturnType<typeof fakeHost>['call']

const BRIEF_FLAGS: [string, string][] = [
  ['provider', 'codex'],
  ['prompt-file', 'brief.md']
]

function run(flagList: [string, string | boolean][], host: ReturnType<typeof fakeHost>) {
  return SESSION_LAUNCH_HANDLERS['session launch']!({
    flags: new Map(flagList),
    client: host.client,
    cwd,
    json: true
  })
}

function callsOf(call: CallMock, method: string): unknown[] {
  return call.mock.calls.filter(([name]) => name === method).map(([, params]) => params)
}

function lastJson(): { result: Record<string, unknown> } {
  return JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0] as string)
}

function launchArgv(...extra: string[]): string[] {
  return ['session', 'launch', '--provider', 'claude', '--prompt', 'Do it', ...extra]
}

describe('session launch --ephemeral: spec and parsing', () => {
  const spec = SESSION_LAUNCH_COMMAND_SPECS.find(
    (entry) => entry.path.join(' ') === 'session launch'
  )!

  it('lists --ephemeral as an allowed, documented flag of session launch only', () => {
    expect(spec.allowedFlags).toContain('ephemeral')
    expect(spec.usage).toContain('[--ephemeral]')
    const inspect = SESSION_LAUNCH_COMMAND_SPECS.find(
      (entry) => entry.path.join(' ') === 'session launch-inspect'
    )!
    expect(inspect.allowedFlags).not.toContain('ephemeral')
    const note = spec.notes!.find((entry) => entry.startsWith('--ephemeral'))
    expect(note).toContain('When finished: End')
    expect(note).toContain('ignores the flag without a warning')
  })

  it('accepts --ephemeral anywhere among the launch flags and rejects it on other commands', () => {
    for (const argv of [
      launchArgv('--ephemeral'),
      ['session', 'launch', '--ephemeral', '--provider', 'claude', '--prompt', 'Do it'],
      launchArgv('--ephemeral', '--json')
    ]) {
      const parsed = parseArgs(argv)
      expect(parsed.flags.get('ephemeral')).toBe(true)
      expect(() => validateCommandAndFlags(COMMAND_SPECS, parsed)).not.toThrow()
    }
    const inspect = parseArgs(['session', 'launch-inspect', '--operation-id', 'x', '--ephemeral'])
    expect(() => validateCommandAndFlags(COMMAND_SPECS, inspect)).toThrow(
      /Unknown flag --ephemeral/
    )
  })

  it('reads --ephemeral into the launch input and refuses a value before any host contact', async () => {
    const base = new Map<string, string | boolean>([
      ['provider', 'claude'],
      ['prompt', 'Do it']
    ])
    expect((await readLaunchInput(base, '/')).ephemeral).toBeUndefined()
    const on = await readLaunchInput(new Map([...base, ['ephemeral', true]]), '/')
    expect(on.ephemeral).toBe(true)
    await expect(readLaunchInput(new Map([...base, ['ephemeral', 'yes']]), '/')).rejects.toThrow(
      '--ephemeral takes no value.'
    )
    // `--ephemeral=false` is a value too: refused, never read as "off".
    const assigned = parseArgs(launchArgv('--ephemeral=false')).flags
    await expect(readLaunchInput(assigned, '/')).rejects.toThrow('--ephemeral takes no value.')
  })

  it('records the flag in the launch record only when it was given', () => {
    const plan = {
      route: 'local',
      status: { runtimeId: RUNTIME_ID },
      workspace: { hostId: 'local' },
      host: { name: 'this computer' },
      request: {},
      folderId: null,
      manifest: null
    } as never
    const args = { operationId: 'op', minted: true, intentKey: 'k', now: 1 }
    const input = { provider: 'claude', prompt: 'p', again: false, dryRun: false } as never
    expect(launchRecordFromPlan(plan, { ...args, input }).post).not.toHaveProperty('ephemeral')
    const ephemeral = { ...(input as object), ephemeral: true } as never
    expect(launchRecordFromPlan(plan, { ...args, input: ephemeral }).post.ephemeral).toBe(true)
  })
})

describe('session launch --ephemeral: arming When finished -> End', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    userData = mkdtempSync(join(tmpdir(), 'omni-launch-userdata-'))
    cwd = mkdtempSync(join(tmpdir(), 'omni-launch-cwd-'))
    writeFileSync(join(cwd, 'brief.md'), 'Do the requested work.')
    vi.stubEnv('ORCA_USER_DATA_PATH', userData)
    vi.stubEnv('ORCA_ENVIRONMENT', '')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    rmSync(userData, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  })

  it('asks the executing host to End the created terminal once it finishes', async () => {
    const host = fakeHost({ 'agentSession.scheduleFinish': () => ({ scheduled: true }) })
    await run([...BRIEF_FLAGS, ['ephemeral', true]], host)
    expect(callsOf(host.call, 'agentSession.scheduleFinish')).toEqual([
      { terminal: 'term_new', action: 'end' }
    ])
    const order = host.call.mock.calls.map(([method]) => method)
    expect(order.indexOf('agentSession.scheduleFinish')).toBeGreaterThan(
      order.indexOf('terminal.createAgentSession')
    )
    expect(lastJson().result.warnings).toEqual([])
  })

  it('never schedules a finish without the flag', async () => {
    const host = fakeHost({ 'agentSession.scheduleFinish': () => ({ scheduled: true }) })
    await run(BRIEF_FLAGS, host)
    expect(callsOf(host.call, 'agentSession.scheduleFinish')).toEqual([])
  })

  it('keeps the launch on a host without scheduleFinish, and does not retry it on a re-run', async () => {
    const host = fakeHost()
    await run([...BRIEF_FLAGS, ['ephemeral', true]], host)
    expect(callsOf(host.call, 'terminal.createAgentSession')).toHaveLength(1)
    expect(callsOf(host.call, 'agentSession.scheduleFinish')).toHaveLength(1)
    // Current behaviour: an older host makes --ephemeral a silent no-op (no warning).
    expect(lastJson().result.warnings).toEqual([])
    await run([...BRIEF_FLAGS, ['ephemeral', true]], host)
    expect(callsOf(host.call, 'terminal.createAgentSession')).toHaveLength(1)
    expect(callsOf(host.call, 'agentSession.scheduleFinish')).toHaveLength(1)
  })

  it('re-arms End from the record when an interrupted launch is re-run without the flag', async () => {
    writeFileSync(join(cwd, 'contract.json'), JSON.stringify(CONTRACT))
    let binds = 0
    const host = fakeHost({
      'agentSession.scheduleFinish': () => ({ scheduled: true }),
      'agentSession.attachContractVerify': () => {
        binds += 1
        if (binds === 1) {
          throw new RuntimeClientError('runtime_timeout', 'Timed out waiting for the runtime.')
        }
        return { attached: true }
      }
    })
    const contract: [string, string][] = [
      ['provider', 'codex'],
      ['contract', 'contract.json']
    ]
    await run([...contract, ['ephemeral', true]], host)
    await run(contract, host)
    expect(callsOf(host.call, 'terminal.createAgentSession')).toHaveLength(1)
    expect(callsOf(host.call, 'agentSession.scheduleFinish')).toEqual([
      { terminal: 'term_new', action: 'end' },
      { terminal: 'term_new', action: 'end' }
    ])
  })
})
