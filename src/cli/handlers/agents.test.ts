import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeCommandPositionals, parseArgs } from '../args'
import { COMMAND_SPECS } from '../specs'
import { RuntimeClientError, type RuntimeClient } from '../runtime-client'
import { agentTemplateRecords } from '../../shared/agent-template-edits'
import { AGENT_TEMPLATE_HANDLERS, formatAgentTemplateList } from './agents'
import { SESSION_LAUNCH_HANDLERS } from './session-launch'
import { TERMINAL_HANDLERS } from './terminal'

const HANDLERS = { ...AGENT_TEMPLATE_HANDLERS, ...TERMINAL_HANDLERS, ...SESSION_LAUNCH_HANDLERS }
let dir = ''

const TEMPLATES = {
  templates: agentTemplateRecords({
    custom: [{ id: 'advertising', name: 'Advertising', description: '', instructions: '# Ads' }]
  })
}

// Why: a launch reads the routed runtime and its SSH targets before sending today's ssh: payload.
const LAUNCH_HOST_ANSWERS: Record<string, unknown> = {
  'status.get': { runtimeId: '00000000-0000-4000-8000-000000000000', capabilities: [] },
  'ssh.listTargetSummaries': { targets: [{ id: 'box', label: 'box' }] }
}

async function run(
  argv: string[],
  result: unknown = {},
  options: { isRemote?: boolean; oldHost?: boolean } = {}
) {
  const parsed = parseArgs(argv)
  const handler = HANDLERS[parsed.commandPath.join(' ')]!
  const call = vi.fn(async (method: string, _params?: unknown, _options?: unknown) => {
    // Why: launches preflight the host's templates; other calls get the test's result.
    if (method === 'agentTemplates.list' && argv[0] !== 'agents') {
      if (options.oldHost) {
        throw new RuntimeClientError('method_not_found', 'Unknown method')
      }
      return { id: 'req', ok: true, result: TEMPLATES }
    }
    if (argv[1] === 'launch' && method in LAUNCH_HOST_ANSWERS) {
      return { id: 'req', ok: true, result: LAUNCH_HOST_ANSWERS[method] }
    }
    return { id: 'req', ok: true, result }
  })
  await handler({
    flags: parsed.flags,
    client: { call, isRemote: options.isRemote === true } as unknown as RuntimeClient,
    cwd: dir,
    json: true
  })
  return call
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omni-agents-cli-'))
  // Why: session launch writes its durable record under userData; keep it in the test dir.
  vi.stubEnv('ORCA_USER_DATA_PATH', dir)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

describe('omni agents', () => {
  it('lists through agentTemplates.list', async () => {
    const call = await run(['agents', 'list'], { templates: [] })
    expect(call).toHaveBeenCalledWith('agentTemplates.list')
  })

  it('shows one template, and refuses an unknown id', async () => {
    const templates = agentTemplateRecords(undefined)
    await run(['agents', 'show', '--id', 'developer'], { templates })
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string)).toMatchObject({
      result: { template: { id: 'developer', digest: '1f319edbed97' } }
    })
    await expect(run(['agents', 'show', '--id', 'nope'], { templates })).rejects.toThrow(
      'Unknown agent template "nope"'
    )
  })

  it('sets from a file, keeping its text exactly', async () => {
    writeFileSync(join(dir, 'ads.md'), '# Advertising\nPause, never scale.\n')
    const call = await run([
      'agents',
      'set',
      '--id',
      'advertising',
      '--name',
      'Advertising',
      '--instructions-file',
      'ads.md'
    ])
    expect(call).toHaveBeenCalledWith('agentTemplates.set', {
      id: 'advertising',
      name: 'Advertising',
      instructions: '# Advertising\nPause, never scale.\n'
    })
  })

  it('needs exactly one instructions source', async () => {
    await expect(run(['agents', 'set', '--id', 'qa'])).rejects.toThrow('exactly one')
    writeFileSync(join(dir, 'qa.md'), 'x')
    await expect(
      run(['agents', 'set', '--id', 'qa', '--instructions', 'x', '--instructions-file', 'qa.md'])
    ).rejects.toThrow('exactly one')
    await expect(
      run(['agents', 'set', '--id', 'qa', '--instructions-file', 'missing.md'])
    ).rejects.toThrow('Cannot read --instructions-file')
  })

  it('removes through agentTemplates.remove, also as "agents remove"', async () => {
    const call = await run(['agents', 'rm', '--id', 'qa'], { removed: 'qa' })
    expect(call).toHaveBeenCalledWith('agentTemplates.remove', { id: 'qa' })
    const alias = normalizeCommandPositionals(COMMAND_SPECS, parseArgs(['agents', 'remove']))
    expect(alias.commandPath).toEqual(['agents', 'rm'])
  })

  it('lists one line per template with its digest', () => {
    const text = formatAgentTemplateList({ templates: agentTemplateRecords(undefined) })
    expect(text).toContain('developer  Developer  (built-in)  digest 1f319edbed97')
  })
})

const LAUNCH = [
  'session',
  'launch',
  '--worktree',
  'id:w',
  '--host',
  'ssh:box',
  '--controller-runtime-id',
  '00000000-0000-4000-8000-000000000000',
  '--provider',
  'claude',
  '--model',
  'opus',
  '--effort',
  'high',
  '--prompt-file',
  'brief.md',
  '--operation-id'
]

describe('--agent-template refusals', () => {
  const created = { terminal: { handle: 't', worktreeId: 'w', title: null } }

  it('refuses a blank or valueless flag before any launch', async () => {
    await expect(
      run(['terminal', 'create', '--worktree', 'id:w', '--agent-template', ''], created)
    ).rejects.toThrow('--agent-template needs a template id')
    await expect(
      run(['terminal', 'create', '--worktree', 'id:w', '--agent-template', '--focus'], created)
    ).rejects.toThrow('--agent-template needs a template id')
  })

  it('refuses an unknown id and an older host that would drop it', async () => {
    await expect(
      run(['terminal', 'create', '--worktree', 'id:w', '--agent-template', 'nope'], created)
    ).rejects.toThrow('Unknown agent template "nope"')
    await expect(
      run(
        ['terminal', 'create', '--worktree', 'id:w', '--agent-template', 'advertising'],
        created,
        {
          oldHost: true
        }
      )
    ).rejects.toMatchObject({ code: 'unsupported_runtime_capability' })
  })

  it('refuses a remote session launch, which could not record it', async () => {
    writeFileSync(join(dir, 'brief.md'), 'Do the work.')
    await expect(
      run(
        [
          ...LAUNCH,
          `${Date.now()}-0123456789abcdef0123456789abcdef`,
          '--agent-template',
          'advertising'
        ],
        created,
        { isRemote: true }
      )
    ).rejects.toThrow('recorded only by a local controller')
  })
})

describe('--agent-template on launches', () => {
  it('terminal create sends agentTemplateId', async () => {
    const call = await run(
      ['terminal', 'create', '--worktree', 'id:w', '--agent-template', 'advertising'],
      { terminal: { handle: 't', worktreeId: 'w', title: null } }
    )
    expect(call).toHaveBeenCalledWith(
      'terminal.create',
      expect.objectContaining({ agentTemplateId: 'advertising' })
    )
  })

  it('session launch sends agentTemplateId', async () => {
    writeFileSync(join(dir, 'brief.md'), 'Do the work.')
    const call = await run(
      [
        'session',
        'launch',
        '--worktree',
        'id:w',
        '--host',
        'ssh:box',
        '--controller-runtime-id',
        '00000000-0000-4000-8000-000000000000',
        '--provider',
        'claude',
        '--model',
        'opus',
        '--effort',
        'high',
        '--prompt-file',
        'brief.md',
        '--operation-id',
        `${Date.now()}-0123456789abcdef0123456789abcdef`,
        '--agent-template',
        'advertising'
      ],
      { terminal: { handle: 't', worktreeId: 'w', title: null }, disposition: 'created' }
    )
    expect(call).toHaveBeenCalledWith(
      'terminal.createAgentSession',
      expect.objectContaining({ agentTemplateId: 'advertising' }),
      expect.anything()
    )
  })
})
