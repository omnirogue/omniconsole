import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_SESSION_EFFORT_ONLY_LAUNCH_RUNTIME_CAPABILITY,
  AGENT_SESSION_VERIFIED_ACCOUNT_LAUNCH_RUNTIME_CAPABILITY
} from '../../shared/protocol-version'
import { canonicalizeLaunchHostFlag, type LaunchHostNameDeps } from '../launch-host-name'
import { RuntimeClientError, type RuntimeClient } from '../runtime-client'
import { agentLaunchRecordStore } from '../session-launch-record'
import { quoteCliCommandArgument } from '../shell-command-quote'
import { SESSION_LAUNCH_HANDLERS } from './session-launch'
import { fileNewTerminal, resolveFolderForNewTerminal } from './session-folders'
import { runPlacedLaunch } from './session-launch-placement'
import { bindProjectLaunch, projectBriefForLaunch } from './session-launch-project'

vi.mock('./session-folders', () => ({
  fileNewTerminal: vi.fn(),
  resolveFolderForNewTerminal: vi.fn()
}))
// Why: placement has its own tests (session-launch-placement.test.ts).
vi.mock('./session-launch-placement', () => ({ runPlacedLaunch: vi.fn(async () => {}) }))
// Why: project inheritance has its own tests (session-launch-project.test.ts).
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
const RUNTIME_B = '22222222-2222-4222-8222-222222222222'
const VERIFIED = AGENT_SESSION_VERIFIED_ACCOUNT_LAUNCH_RUNTIME_CAPABILITY
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
  excluded: [{ label: 'ops@example.com', reason: 'limited until 15:00 (5-hour)' }],
  why: 'most fresh verified headroom (71%, weekly) of 3 verified accounts'
}
let userData = ''
let cwd = ''

type HostAnswers = Record<string, (params: Record<string, unknown>) => unknown>

function fakeHost(overrides: HostAnswers = {}, isRemote = false) {
  const answers: HostAnswers = {
    'status.get': () => ({
      runtimeId: RUNTIME_ID,
      appVersion: '1.12.19',
      capabilities: [VERIFIED, AGENT_SESSION_EFFORT_ONLY_LAUNCH_RUNTIME_CAPABILITY]
    }),
    'worktree.list': () => ({ worktrees: [{ id: `repo::${cwd}`, path: cwd }] }),
    'ssh.listTargetSummaries': () => ({ targets: [{ id: 'worker', label: 'Worker box' }] }),
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
  return { call, client: { call, isRemote } as unknown as RuntimeClient }
}

type CallMock = ReturnType<typeof fakeHost>['call']

function launch(
  extra: [string, string | boolean][] = [],
  host = fakeHost(),
  options: { json?: boolean; base?: [string, string | boolean][] } = {}
) {
  const flags = new Map<string, string | boolean>([
    ...(options.base ?? [
      ['provider', 'codex'],
      ['prompt-file', 'brief.md']
    ]),
    ...extra
  ])
  const run = () =>
    SESSION_LAUNCH_HANDLERS['session launch']!({
      flags,
      client: host.client,
      cwd,
      json: options.json ?? true
    })
  return { flags, run, call: host.call }
}

function sentRequest(call: CallMock): Record<string, unknown> {
  const sent = call.mock.calls.find(([method]) => method === 'terminal.createAgentSession')
  return sent?.[1] as Record<string, unknown>
}

function methods(call: CallMock): string[] {
  return call.mock.calls.map(([method]) => method as string)
}

function lastJson(): { result: Record<string, unknown> } {
  return JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0] as string)
}

function timesOut(): never {
  throw new RuntimeClientError(
    'runtime_timeout',
    'Timed out waiting for the OmniConsole runtime to respond.'
  )
}

const SSH_WORKSPACE_READINESS = {
  'terminal.agentLaunchReadiness': () => ({
    runtimeId: RUNTIME_ID,
    workspace: { id: 'repo::/srv', hostId: 'ssh:worker', kind: 'git', path: '/srv', name: null }
  })
}

function recordFiles(): string[] {
  const dir = join(userData, 'agent-launch-operations')
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')) : []
}

function lastRecordedOperationId(): string {
  return recordFiles().sort().at(-1)!.slice(0, -'.json'.length)
}

describe('omni session launch', () => {
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

  it('--project never builds the routed client, so a stale ambient selector cannot refuse it', async () => {
    const flags = new Map<string, string | boolean>([
      ['provider', 'claude'],
      ['prompt-file', 'brief.md'],
      ['project', 'github:omnirogue/omni-ide']
    ])
    await SESSION_LAUNCH_HANDLERS['session launch']!({
      flags,
      get client(): RuntimeClient {
        throw new Error('Unknown environment: desk')
      },
      cwd,
      json: true
    })
    expect(runPlacedLaunch).toHaveBeenCalledWith(
      { flags, cwd, json: true },
      expect.objectContaining({ project: 'github:omnirogue/omni-ide' })
    )
  })

  it('with only provider and brief, launches the cwd workspace with expectedHostId from readiness and runtime id from status.get', async () => {
    const { run, call } = launch()
    await run()
    expect(methods(call)).toEqual([
      'status.get',
      'worktree.list',
      'terminal.agentLaunchReadiness',
      'terminal.createAgentSession',
      // Every `session launch` is an agent's: its host lists it in Agent sessions.
      'agentSession.markAgentSession'
    ])
    expect(call).toHaveBeenCalledWith(
      'terminal.agentLaunchReadiness',
      { worktree: `id:repo::${cwd}`, agent: 'codex', preview: false },
      { timeoutMs: 20_000 }
    )
    expect(call).toHaveBeenCalledWith(
      'terminal.createAgentSession',
      expect.objectContaining({
        clientOperationId: expect.stringMatching(/^\d{13}-[0-9a-f]{32}$/),
        worktree: `id:repo::${cwd}`,
        agent: 'codex',
        prompt: 'Do the requested work.',
        revealInSidebar: true,
        sshAccountSelection: {
          policy: 'best-verified',
          expectedHostId: 'local',
          expectedRuntimeId: RUNTIME_ID
        }
      }),
      { timeoutMs: 240_000 }
    )
    expect(lastJson().result).toMatchObject({
      disposition: 'created',
      operationId: sentRequest(call).clientOperationId,
      host: { route: 'local', name: 'this computer', hostId: 'local', runtimeId: RUNTIME_ID },
      account: { label: 'sal@example.com (pool slot-3)', remainingPercent: 71 },
      launch: { model: 'gpt-5.5', effort: 'xhigh', source: 'host-default' },
      retryCommand: expect.arrayContaining(['session', 'launch', '--provider', 'codex'])
    })
  })

  it('falls back to path:<cwd> outside every managed worktree, and refuses by name when the host has none there', async () => {
    const outside = fakeHost({ 'worktree.list': () => ({ worktrees: [] }) })
    await launch([], outside).run()
    expect(sentRequest(outside.call).worktree).toBe(`path:${cwd}`)
    const missing = fakeHost({
      'worktree.list': () => ({ worktrees: [] }),
      'terminal.agentLaunchReadiness': () => {
        throw new RuntimeClientError('selector_not_found', 'No workspace')
      }
    })
    await expect(launch([['model', 'gpt-9-future']], missing).run()).rejects.toThrow(
      `No OmniConsole workspace contains ${cwd} on this computer`
    )
    expect(methods(missing.call)).not.toContain('terminal.createAgentSession')
  })

  it('records before createAgentSession and prints the operation id to stderr first', async () => {
    let atSend: { records: string[]; stderr: string } | null = null
    const host = fakeHost({
      'terminal.createAgentSession': (params) => {
        atSend = {
          records: recordFiles(),
          stderr: vi
            .mocked(process.stderr.write)
            .mock.calls.map(([text]) => String(text))
            .join('')
        }
        const record = agentLaunchRecordStore(userData).read(String(params.clientOperationId))
        expect(record?.request).toEqual(params)
        expect(record?.sends).toEqual([{ at: expect.any(Number), outcome: null }])
        return {
          terminal: { handle: 'term_new', worktreeId: 'w', title: null },
          disposition: 'created'
        }
      }
    })
    await launch([], host).run()
    const operationId = String(sentRequest(host.call).clientOperationId)
    expect(atSend).toEqual({
      records: [`${operationId}.json`],
      stderr: expect.stringContaining(`operation ${operationId}`)
    })
    expect(agentLaunchRecordStore(userData).read(operationId)).toMatchObject({
      outcome: 'created',
      sends: [{ outcome: 'created' }],
      post: { done: true }
    })
  })

  it("a paired route sends local and that runtime's id, without revealInSidebar", async () => {
    const paired = fakeHost({}, true)
    await launch(
      [
        ['worktree', 'id:repo::/w'],
        ['host', 'runtime:env-studio']
      ],
      paired
    ).run()
    const request = sentRequest(paired.call)
    expect(request).not.toHaveProperty('revealInSidebar')
    expect(request.sshAccountSelection).toEqual({
      policy: 'best-verified',
      expectedHostId: 'local',
      expectedRuntimeId: RUNTIME_ID
    })
    expect(lastJson().result.host).toMatchObject({
      route: 'paired',
      why: 'named with --host',
      visibleIn:
        "env-studio's sidebar (background); inspect terminals: omni terminal list --environment env-studio --json"
    })
  })

  it('refuses the cwd shortcut on a paired route with the list command', async () => {
    const paired = fakeHost({}, true)
    await expect(launch([['environment', 'Mac Studio']], paired).run()).rejects.toThrow(
      'List them: omni worktree list --environment'
    )
    expect(paired.call).not.toHaveBeenCalled()
  })

  it('an explicit ssh: label is resolved to its id', async () => {
    const host = fakeHost({
      'terminal.agentLaunchReadiness': () => ({
        runtimeId: RUNTIME_ID,
        workspace: { id: 'repo::/srv', hostId: 'ssh:worker', kind: 'git', path: '/srv', name: null }
      })
    })
    await launch(
      [
        ['worktree', 'id:repo::/srv'],
        ['host', 'ssh:Worker box']
      ],
      host
    ).run()
    expect(sentRequest(host.call).sshAccountSelection).toMatchObject({
      expectedHostId: 'ssh:worker'
    })
    expect(lastJson().result.host).toMatchObject({ route: 'ssh', name: 'Worker box' })
  })

  it('refuses a named computer that does not hold the workspace before anything is sent', async () => {
    const host = fakeHost()
    await expect(
      launch(
        [
          ['worktree', 'id:repo::/w'],
          ['host', 'ssh:worker']
        ],
        host
      ).run()
    ).rejects.toMatchObject({ code: 'agent_session_host_mismatch' })
    expect(recordFiles()).toEqual([])
    expect(methods(host.call)).not.toContain('terminal.createAgentSession')
  })

  it('missing capability refuses before any record or send', async () => {
    const old = fakeHost({
      'status.get': () => ({ runtimeId: RUNTIME_ID, appVersion: '1.12.18', capabilities: [] })
    })
    await expect(launch([], old).run()).rejects.toMatchObject({
      code: 'incompatible_runtime',
      message: expect.stringContaining(
        "This computer's running OmniConsole (1.12.18) cannot verify"
      )
    })
    const pairedOld = fakeHost(
      { 'status.get': () => ({ runtimeId: RUNTIME_ID, appVersion: '1.12.18' }) },
      true
    )
    await expect(
      launch(
        [
          ['worktree', 'id:w'],
          ['host', 'runtime:Mac Studio']
        ],
        pairedOld
      ).run()
    ).rejects.toThrow('runs OmniConsole 1.12.18, which cannot verify account capacity')
    expect(methods(old.call)).toEqual(['status.get'])
    expect(methods(pairedOld.call)).toEqual(['status.get'])
    expect(recordFiles()).toEqual([])
  })

  it("explicit ssh: against an old runtime sends today's exact payload", async () => {
    const old = fakeHost({ 'status.get': () => ({ runtimeId: RUNTIME_ID, capabilities: [] }) })
    await launch(
      [
        ['worktree', 'id:remote-workspace'],
        ['host', 'ssh:worker'],
        ['model', 'pinned-model'],
        ['effort', 'high']
      ],
      old
    ).run()
    expect(methods(old.call)).not.toContain('terminal.agentLaunchReadiness')
    expect(sentRequest(old.call)).toEqual({
      clientOperationId: expect.stringMatching(/^\d{13}-[0-9a-f]{32}$/),
      worktree: 'id:remote-workspace',
      agent: 'codex',
      prompt: 'Do the requested work.',
      promptDelivery: 'auto-submit',
      presentation: 'background',
      revealInSidebar: true,
      viewMode: 'terminal',
      launchPreferences: { model: 'pinned-model', effort: 'high' },
      sshAccountSelection: {
        policy: 'best-verified',
        expectedHostId: 'ssh:worker',
        expectedRuntimeId: RUNTIME_ID
      }
    })
  })

  it('omitting model and effort sends no launchPreferences', async () => {
    const { run, call } = launch()
    await run()
    expect(sentRequest(call)).not.toHaveProperty('launchPreferences')
  })

  it('effort is validated only for catalog-known models', async () => {
    const known = launch([
      ['model', 'gpt-5.5'],
      ['effort', 'ultra']
    ])
    await expect(known.run()).rejects.toThrow('--effort ultra is not a codex effort for gpt-5.5')
    expect(known.call).not.toHaveBeenCalled()
    const newer = launch([
      ['model', 'gpt-9-future'],
      ['effort', 'ultra']
    ])
    await newer.run()
    expect(sentRequest(newer.call).launchPreferences).toEqual({
      model: 'gpt-9-future',
      effort: 'ultra'
    })
  })

  it('effort-only needs the host capability', async () => {
    const without = fakeHost({
      'status.get': () => ({
        runtimeId: RUNTIME_ID,
        appVersion: '1.12.19',
        capabilities: [VERIFIED]
      })
    })
    await expect(launch([['effort', 'high']], without).run()).rejects.toMatchObject({
      code: 'incompatible_runtime',
      message: expect.stringContaining('agent-session.effort-only-launch.v1')
    })
    expect(methods(without.call)).not.toContain('terminal.createAgentSession')
    const withCapability = launch([['effort', 'high']])
    await withCapability.run()
    expect(sentRequest(withCapability.call).launchPreferences).toEqual({ effort: 'high' })
  })

  it('inline --prompt and --prompt-file - are accepted and capped at 256 KiB', async () => {
    const base: [string, string][] = [['provider', 'codex']]
    const inline = launch([['prompt', 'Inline brief.']], fakeHost(), { base })
    await inline.run()
    expect(sentRequest(inline.call).prompt).toBe('Inline brief.')
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(
      Object.assign(Readable.from(['Piped brief.']), {
        isTTY: false
      }) as unknown as typeof process.stdin
    )
    const piped = launch([['prompt-file', '-']], fakeHost(), { base })
    await piped.run()
    expect(sentRequest(piped.call).prompt).toBe('Piped brief.')
    const tooLarge = launch([['prompt', 'x'.repeat(256 * 1024 + 1)]], fakeHost(), { base })
    await expect(tooLarge.run()).rejects.toThrow('at most 256 KiB')
    await expect(launch([['prompt', 'Both.']]).run()).rejects.toThrow('Pass the brief exactly once')
    expect(tooLarge.call).not.toHaveBeenCalled()
  })

  it('timeout is recorded unverifiable and the error carries retryCommand and inspectCommand', async () => {
    const host = fakeHost({
      'terminal.createAgentSession': () => {
        throw new RuntimeClientError(
          'runtime_timeout',
          'Timed out waiting for the OmniConsole runtime to respond.'
        )
      }
    })
    const error = await launch([], host)
      .run()
      .catch((caught: unknown) => caught)
    const operationId = String(sentRequest(host.call).clientOperationId)
    expect(error).toMatchObject({
      code: 'launch_outcome_unknown',
      message: expect.stringContaining('did not confirm the launch within 240 s'),
      data: {
        operationId,
        outcome: 'unverifiable',
        retryCommand: expect.arrayContaining(['session', 'launch', '--prompt-file', 'brief.md']),
        inspectCommand: expect.arrayContaining(['session', 'list', '--json'])
      }
    })
    expect(agentLaunchRecordStore(userData).read(operationId)).toMatchObject({
      outcome: 'unverifiable',
      sends: [{ outcome: 'unverifiable', code: 'runtime_timeout' }]
    })
    // The same command again resends the recorded bytes under the same operation.
    const retry = launch([], fakeHost())
    await retry.run()
    expect(sentRequest(retry.call).clientOperationId).toBe(operationId)
  })

  it('a re-run after created answers already-launched without contacting the host', async () => {
    await launch().run()
    const first = lastJson().result
    const again = launch()
    await again.run()
    expect(again.call).not.toHaveBeenCalled()
    expect(lastJson().result).toMatchObject({
      disposition: 'already-launched',
      operationId: first.operationId,
      terminal: { handle: 'term_new' }
    })
    const another = launch([['again', true]])
    await another.run()
    expect(sentRequest(another.call).clientOperationId).not.toBe(first.operationId)
  })

  it('dry-run calls readiness preview only and writes nothing', async () => {
    const { run, call } = launch([['dry-run', true]])
    await run()
    expect(methods(call)).toEqual(['status.get', 'worktree.list', 'terminal.agentLaunchReadiness'])
    expect(call).toHaveBeenCalledWith(
      'terminal.agentLaunchReadiness',
      expect.objectContaining({ preview: true }),
      expect.anything()
    )
    expect(existsSync(join(userData, 'agent-launch-operations'))).toBe(false)
    expect(lastJson().result).toMatchObject({
      launched: false,
      operationId: null,
      account: { verified: true, receipt: { label: 'sal@example.com (pool slot-3)' } },
      wouldRefuse: null
    })
    const old = fakeHost({ 'status.get': () => ({ runtimeId: RUNTIME_ID, capabilities: [] }) })
    await launch([['dry-run', true]], old).run()
    expect(lastJson().result).toMatchObject({ wouldRefuse: { code: 'incompatible_runtime' } })
  })

  it('receipt text names host, account, % left, reading age and why', async () => {
    await launch([], fakeHost(), { json: false }).run()
    const text = String(vi.mocked(console.log).mock.calls.at(-1)![0])
    expect(text).toContain('Launched codex on this computer (local, OmniConsole 1.12.19): term_new')
    expect(text).toContain(
      'account   sal@example.com (pool slot-3): 71% left (weekly), read 10 s before selection; best of 3 verified'
    )
    expect(text).toContain('model     gpt-5.5, effort xhigh (host defaults)')
    expect(text).toContain('Run this same command again; it never starts a second session.')
  })

  it('forwards --agent-args as the complete provider flag set and omits it otherwise', async () => {
    const plain = launch()
    await plain.run()
    expect(sentRequest(plain.call)).not.toHaveProperty('agentArgs')
    const args =
      '--dangerously-skip-permissions --append-system-prompt "Role: reviewer" --disallowedTools Write'
    const withArgs = launch([['agent-args', args]])
    await withArgs.run()
    expect(sentRequest(withArgs.call).agentArgs).toBe(args)
  })

  it('does not use terminal.create as an old-runtime fallback', async () => {
    const host = fakeHost({
      'terminal.createAgentSession': () => {
        throw new Error('unknown parameter')
      }
    })
    await expect(launch([], host).run()).rejects.toThrow('unknown parameter')
    expect(
      methods(host.call).filter((method) => method === 'terminal.createAgentSession')
    ).toHaveLength(1)
    expect(methods(host.call)).not.toContain('terminal.create')
  })

  it('checks filing before launch and reports a later filing failure beside the created terminal', async () => {
    const refused = launch([['folder', 'Worker Agents']])
    vi.mocked(resolveFolderForNewTerminal).mockRejectedValueOnce(new Error('unknown folder'))
    await expect(refused.run()).rejects.toThrow('unknown folder')
    expect(methods(refused.call)).not.toContain('terminal.createAgentSession')
    vi.mocked(resolveFolderForNewTerminal).mockResolvedValue('folder-id')
    vi.mocked(fileNewTerminal).mockRejectedValue(new Error('lost receipt'))
    const filed = launch([['folder', 'Worker Agents']])
    await filed.run()
    expect(
      methods(filed.call).filter((method) => method === 'terminal.createAgentSession')
    ).toHaveLength(1)
    const output = lastJson()
    expect(output.result).toMatchObject({ terminal: { handle: 'term_new' } })
    expect((output.result.warnings as string[])[0]).toContain('do not launch another')
  })

  it('keeps the project context on the new tab, and warns when the window could not', async () => {
    vi.mocked(resolveFolderForNewTerminal).mockResolvedValue('folder-id')
    vi.mocked(fileNewTerminal).mockResolvedValue({ summary: 'Filed in Ads' } as never)
    vi.mocked(bindProjectLaunch).mockResolvedValueOnce(
      'The session’s project context is not kept on its tab, so a restart will not re-deliver it.'
    )
    await launch([['folder', 'Ads']]).run()
    expect(bindProjectLaunch).toHaveBeenCalledWith(expect.anything(), 'term_new', [])
    expect(lastJson().result.warnings).toContain(
      'The session’s project context is not kept on its tab, so a restart will not re-deliver it.'
    )
  })

  it('keeps the original terminal receipt and renderer warning when adoption is unavailable', async () => {
    const host = fakeHost({
      'terminal.createAgentSession': () => ({
        terminal: {
          handle: 'term_new',
          worktreeId: 'w',
          title: null,
          warning: 'Renderer unavailable; reveal this terminal later.'
        },
        disposition: 'created'
      })
    })
    await launch([], host).run()
    expect(lastJson().result).toMatchObject({
      terminal: { handle: 'term_new' },
      warnings: ['Renderer unavailable; reveal this terminal later.']
    })
  })

  it('an --again launch tells a retry to drop --again, so following the advice reuses the operation', async () => {
    const timedOut = fakeHost({ 'terminal.createAgentSession': timesOut })
    const error = await launch([['again', true]], timedOut)
      .run()
      .catch((caught: unknown) => caught)
    const operationId = String(sentRequest(timedOut.call).clientOperationId)
    expect(error).toMatchObject({
      code: 'launch_outcome_unknown',
      message: expect.stringContaining(
        `run this command again without --again (it reuses operation ${operationId}`
      ),
      data: {
        retryCommand: expect.not.arrayContaining(['--again']),
        nextSteps: expect.arrayContaining(['Run this command again without --again.'])
      }
    })
    const stderr = vi
      .mocked(process.stderr.write)
      .mock.calls.map(([text]) => String(text))
      .join('')
    expect(stderr).toContain('run this command again without --again; it reuses this operation')
    const retry = launch([], fakeHost())
    await retry.run()
    expect(sentRequest(retry.call).clientOperationId).toBe(operationId)
    await launch([['again', true]], fakeHost(), { json: false }).run()
    expect(String(vi.mocked(console.log).mock.calls.at(-1)![0])).toContain(
      'Unsure it started? Run this command again without --again; it never starts a second session.'
    )
  })

  it('a retry that cannot reach the host keeps the recorded operation and never says nothing was sent', async () => {
    await launch([], fakeHost({ 'terminal.createAgentSession': timesOut }))
      .run()
      .catch(() => undefined)
    const operationId = lastRecordedOperationId()
    const down = fakeHost({
      'status.get': () => {
        throw new RuntimeClientError('runtime_unavailable', 'OmniConsole is not running.')
      }
    })
    const error = await launch([], down)
      .run()
      .catch((caught: unknown) => caught)
    expect(error).toMatchObject({
      code: 'launch_host_unverifiable',
      message: expect.stringContaining(
        `retry operation ${operationId}; whether it started is unverifiable. Nothing new launched.`
      ),
      data: { operationId, outcome: 'unverifiable', retryCommand: expect.any(Array) }
    })
    expect((error as Error).message).not.toContain('Nothing was sent')
    expect(methods(down.call)).toEqual(['status.get'])
  })

  it('a re-run whose --host name now resolves to the other route refuses with the recorded operation instead of minting', async () => {
    const names = (workspaceHostId: string | null): LaunchHostNameDeps => ({
      listEnvironments: async () => [{ id: 'env-2586', name: 'mw0002' }],
      listSshTargets: async () => [{ id: 'worker', label: 'mw0002' }],
      localWorkspaceHostId: async () => workspaceHostId,
      serverSelected: false
    })
    const typed: [string, string][] = [
      ['worktree', 'id:repo::/srv'],
      ['host', 'mw0002']
    ]
    const viaSsh = launch(
      typed,
      fakeHost({ ...SSH_WORKSPACE_READINESS, 'terminal.createAgentSession': timesOut })
    )
    await canonicalizeLaunchHostFlag(viaSsh.flags, names('ssh:worker'))
    const first = await viaSsh.run().catch((caught: unknown) => caught)
    const operationId = String(sentRequest(viaSsh.call).clientOperationId)
    // Why: the retry command keeps the typed name, so it hashes to the same launch record.
    expect(first).toMatchObject({
      data: { retryCommand: expect.arrayContaining(['--host', 'mw0002']) }
    })
    const paired = launch(typed, fakeHost({}, true))
    await canonicalizeLaunchHostFlag(paired.flags, names(null))
    expect(paired.flags.get('host')).toBe('runtime:env-2586')
    await expect(paired.run()).rejects.toMatchObject({
      code: 'launch_host_unverifiable',
      message: expect.stringContaining('--host now resolves to OmniConsole on'),
      data: { operationId, outcome: 'unverifiable' }
    })
    expect(paired.call).not.toHaveBeenCalled()
  })

  it('a run whose operation an identical run already replaced refuses instead of replacing it again', async () => {
    const replacement = '1759450000000-0123456789abcdef0123456789abcdef'
    let statusCalls = 0
    const host = fakeHost({
      'status.get': () => {
        statusCalls += 1
        if (statusCalls === 2) {
          // Why: an identical run took the claim between this run's settle and its supersede.
          const store = agentLaunchRecordStore(userData)
          const seen = store.read(lastRecordedOperationId())!
          store.write({ ...seen, supersededBy: replacement })
        }
        return {
          runtimeId: statusCalls === 1 ? RUNTIME_ID : RUNTIME_B,
          appVersion: '1.12.19',
          capabilities: [VERIFIED]
        }
      },
      'terminal.createAgentSession': () => {
        throw new RuntimeClientError('agent_session_runtime_changed', 'Runtime restarted.')
      }
    })
    await expect(launch([], host).run()).rejects.toMatchObject({
      code: 'agent_session_runtime_changed',
      message: expect.stringContaining(`already replaced it with operation ${replacement}`),
      data: { outcome: 'not-started' }
    })
    expect(
      methods(host.call).filter((method) => method === 'terminal.createAgentSession')
    ).toHaveLength(1)
  })

  it('refuses a project prompt over the host cap before recording or sending', async () => {
    vi.mocked(resolveFolderForNewTerminal).mockResolvedValue('folder-id')
    vi.mocked(projectBriefForLaunch).mockResolvedValueOnce({
      prompt: 'x'.repeat(256 * 1024 + 1),
      report: null,
      warnings: [],
      items: []
    } as never)
    const oversized = launch([['folder', 'Ads']])
    await expect(oversized.run()).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('Nothing was sent.'),
      data: { outcome: 'not-sent' }
    })
    expect(methods(oversized.call)).not.toContain('terminal.createAgentSession')
    expect(recordFiles()).toEqual([])
  })

  it('a pairing-code route names the code, not a made-up computer name, in its inspect commands', async () => {
    const paired = fakeHost({ 'terminal.createAgentSession': timesOut }, true)
    const error = await launch(
      [
        ['worktree', 'id:repo::/w'],
        ['pairing-code', 'omni://pair#secret']
      ],
      paired
    )
      .run()
      .catch((caught: unknown) => caught)
    expect(error).toMatchObject({
      code: 'launch_outcome_unknown',
      message: expect.stringContaining(
        `omni session list --json --pairing-code ${quoteCliCommandArgument('<pairing code>')}`
      ),
      data: {
        inspectCommand: expect.arrayContaining(['--pairing-code', '<pairing code>']),
        retryCommand: expect.arrayContaining(['--pairing-code', '<pairing code>'])
      }
    })
    const data = JSON.stringify((error as RuntimeClientError).data)
    expect(data).not.toContain('the paired computer')
    expect(data).not.toContain('secret')
  })

  it('R6 on a paired --host names --environment, because omitting --host would aim at this computer', async () => {
    const paired = fakeHost(SSH_WORKSPACE_READINESS, true)
    await expect(
      launch(
        [
          ['worktree', 'id:repo::/srv'],
          ['host', 'runtime:env-studio']
        ],
        paired
      ).run()
    ).rejects.toMatchObject({
      code: 'agent_session_host_mismatch',
      message: expect.stringContaining(
        'runs on Worker box (ssh:worker), not on runtime:env-studio. Pass --environment env-studio instead of --host to launch where it lives. Nothing was sent.'
      ),
      data: {
        outcome: 'not-sent',
        nextSteps: [
          'Pass --environment env-studio instead of --host, or pass a --worktree that lives on that computer.'
        ]
      }
    })
    expect(methods(paired.call)).not.toContain('terminal.createAgentSession')
  })
})
