import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_SESSION_EFFORT_ONLY_LAUNCH_RUNTIME_CAPABILITY,
  AGENT_SESSION_VERIFIED_ACCOUNT_LAUNCH_RUNTIME_CAPABILITY
} from '../../shared/protocol-version'
import { RuntimeClientError, type RuntimeClient } from '../runtime-client'
import { SESSION_LAUNCH_HANDLERS } from './session-launch'

vi.mock('./session-folders', () => ({
  fileNewTerminal: vi.fn(),
  resolveFolderForNewTerminal: vi.fn()
}))
vi.mock('./session-launch-placement', () => ({ runPlacedLaunch: vi.fn(async () => {}) }))
vi.mock('./session-launch-project', () => ({
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
let userData = ''
let cwd = ''

type HostAnswers = Record<string, (params: Record<string, unknown>) => unknown>

// The same host answers session-launch.test.ts uses, cut to what a local launch reads.
function fakeHost(overrides: HostAnswers = {}) {
  const answers: HostAnswers = {
    'status.get': () => ({
      runtimeId: RUNTIME_ID,
      appVersion: '1.12.19',
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

function launch(
  extra: [string, string | boolean][] = [],
  host = fakeHost(),
  options: { base?: [string, string | boolean][] } = {}
) {
  const flags = new Map<string, string | boolean>([
    ...(options.base ?? [
      ['provider', 'codex'],
      ['prompt-file', 'brief.md']
    ]),
    ...extra
  ])
  const run = () =>
    SESSION_LAUNCH_HANDLERS['session launch']!({ flags, client: host.client, cwd, json: true })
  return { flags, run, call: host.call }
}

function sentRequest(call: CallMock): Record<string, unknown> {
  const sent = call.mock.calls.find(([method]) => method === 'terminal.createAgentSession')
  return sent?.[1] as Record<string, unknown>
}

function methods(call: CallMock): string[] {
  return call.mock.calls.map(([method]) => method as string)
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
const CONTRACT_FLAGS: [string, string][] = [
  ['provider', 'codex'],
  ['contract', 'contract.json']
]

function lastJson(): { result: Record<string, unknown> } {
  return JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0] as string)
}

describe('omni session launch --contract', () => {
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

  it('--contract renders the brief from the implement fields and binds its Acceptance to a verify step', async () => {
    writeFileSync(
      join(cwd, 'contract.json'),
      JSON.stringify({
        objective: 'Fix the login timeout',
        owner: 'Sal',
        host: 'this computer',
        branch: 'none',
        scope: 'src/auth',
        acceptance: 'pnpm test auth exits 0\nthe timeout is 30 seconds in config/auth.ts',
        evidence: 'REPORT.md'
      })
    )
    const host = fakeHost({
      'agentSession.attachContractVerify': () => ({ attached: true })
    })
    await launch([], host, {
      base: [
        ['provider', 'codex'],
        ['contract', 'contract.json']
      ]
    }).run()
    const prompt = String(sentRequest(host.call).prompt)
    expect(prompt).toContain(
      '## Acceptance\n- A1. pnpm test auth exits 0\n- A2. the timeout is 30 seconds in config/auth.ts'
    )
    expect(prompt).toContain('End your final reply with one line per Acceptance item')
    expect(prompt).not.toContain('worker_done')
    const attach = host.call.mock.calls.find(
      ([method]) => method === 'agentSession.attachContractVerify'
    )
    expect(attach?.[1]).toEqual({
      terminal: 'term_new',
      title: 'Fix the login timeout',
      acceptance: ['pnpm test auth exits 0', 'the timeout is 30 seconds in config/auth.ts'],
      agent: 'codex'
    })
    expect(lastJson().result.warnings).toEqual([])
  })

  it('refuses an incomplete contract, or one beside a brief, before anything is sent', async () => {
    writeFileSync(
      join(cwd, 'contract.json'),
      JSON.stringify({ objective: 'Fix it', acceptance: 'TBD' })
    )
    const incomplete = launch([], fakeHost(), {
      base: [
        ['provider', 'codex'],
        ['contract', 'contract.json']
      ]
    })
    await expect(incomplete.run()).rejects.toThrow(/contract is incomplete; nothing was launched/)
    expect(methods(incomplete.call)).not.toContain('terminal.createAgentSession')
    const both = launch([['contract', 'contract.json']])
    await expect(both.run()).rejects.toThrow(/not both: the contract is the brief/)
    expect(methods(both.call)).not.toContain('terminal.createAgentSession')
  })

  it('refuses more Acceptance checks than a verify step can decide, before anything is sent', async () => {
    writeFileSync(
      join(cwd, 'contract.json'),
      JSON.stringify({
        ...CONTRACT,
        acceptance: Array.from({ length: 33 }, (_, at) => `check ${at + 1}`).join('\n')
      })
    )
    const tooMany = launch([], fakeHost(), { base: CONTRACT_FLAGS })
    await expect(tooMany.run()).rejects.toThrow(/at most 32 checks/)
    expect(methods(tooMany.call)).not.toContain('terminal.createAgentSession')
  })

  it('keeps a lost binding open, so running the same command again binds it', async () => {
    writeFileSync(join(cwd, 'contract.json'), JSON.stringify(CONTRACT))
    let calls = 0
    const host = fakeHost({
      'agentSession.attachContractVerify': () => {
        calls += 1
        if (calls === 1) {
          throw new RuntimeClientError('runtime_timeout', 'Timed out waiting for the runtime.')
        }
        return { attached: true }
      }
    })
    await launch([], host, { base: CONTRACT_FLAGS }).run()
    expect((lastJson().result.warnings as string[]).join('\n')).toContain(
      'Run the same command again to retry the binding'
    )
    await launch([], host, { base: CONTRACT_FLAGS }).run()
    expect(calls).toBe(2)
    expect(
      methods(host.call).filter((method) => method === 'terminal.createAgentSession')
    ).toHaveLength(1)
    expect(lastJson().result.warnings).toEqual([])
  })

  it('treats an answer that does not say attached as unconfirmed, so a re-run retries it', async () => {
    writeFileSync(join(cwd, 'contract.json'), JSON.stringify(CONTRACT))
    let calls = 0
    const host = fakeHost({
      'agentSession.attachContractVerify': () => {
        calls += 1
        return calls === 1 ? { scheduled: true, paneKey: 'tab:leaf' } : { attached: true }
      }
    })
    await launch([], host, { base: CONTRACT_FLAGS }).run()
    expect((lastJson().result.warnings as string[]).join('\n')).toContain('was not confirmed')
    await launch([], host, { base: CONTRACT_FLAGS }).run()
    expect(calls).toBe(2)
  })

  it("names the host's reason when it declines to bind", async () => {
    writeFileSync(join(cwd, 'contract.json'), JSON.stringify(CONTRACT))
    const host = fakeHost({
      'agentSession.attachContractVerify': () => ({
        attached: false,
        reason: 'a verify seat cannot read this workspace'
      })
    })
    await launch([], host, { base: CONTRACT_FLAGS }).run()
    expect((lastJson().result.warnings as string[]).join('\n')).toContain(
      'a verify seat cannot read this workspace'
    )
  })

  it('warns, and launches nothing more, when the host cannot bind the contract', async () => {
    writeFileSync(
      join(cwd, 'contract.json'),
      JSON.stringify({
        objective: 'Fix the login timeout',
        owner: 'Sal',
        host: 'this computer',
        branch: 'none',
        scope: 'src/auth',
        acceptance: 'pnpm test auth exits 0',
        evidence: 'REPORT.md'
      })
    )
    const older = launch([], fakeHost(), {
      base: [
        ['provider', 'codex'],
        ['contract', 'contract.json']
      ]
    })
    await older.run()
    expect(
      methods(older.call).filter((method) => method === 'terminal.createAgentSession')
    ).toHaveLength(1)
    expect((lastJson().result.warnings as string[]).join('\n')).toContain(
      'were not bound to a verify step'
    )
  })
})
