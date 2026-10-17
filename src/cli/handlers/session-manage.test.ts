import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatSessionList } from '../session-manage-format'
import type { SessionManageEntry } from '../../shared/session-manage-types'
import { buildAgentContext } from '../agent-context'
import { parseArgs } from '../args'
import type { RuntimeClient } from '../runtime-client'
import { runtimeCompatibilityEnvelope } from '../runtime/orchestration-compatibility-envelope'
import { COMMAND_SPECS } from '../specs'
import { SESSION_FOLDER_HANDLERS } from './session-folders'
import { SESSION_MANAGE_HANDLERS } from './session-manage'

const ORIGINAL_EXIT_CODE = process.exitCode

function client(result: unknown = { summary: 'done', dryRun: false }) {
  const call = vi.fn(async (_method: string, _params?: unknown, _options?: unknown) => ({ result }))
  return { call, client: { call, isRemote: false } as unknown as RuntimeClient }
}

async function run(argv: string[], result?: unknown) {
  const parsed = parseArgs(argv)
  const key = parsed.commandPath.join(' ')
  const handler = SESSION_MANAGE_HANDLERS[key] ?? SESSION_FOLDER_HANDLERS[key]!
  const fake = client(result)
  await handler({ flags: parsed.flags, client: fake.client, cwd: '/tmp', json: true })
  return fake.call
}

const paramsOf = (call: ReturnType<typeof vi.fn>, method: string) =>
  call.mock.calls.find(([name]) => name === method)?.[1] as Record<string, unknown>

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.stubEnv('ORCA_PANE_KEY', 'tab-9:leaf-9')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  process.exitCode = ORIGINAL_EXIT_CODE
})

describe('omni session continue', () => {
  it('sends the answer, the target, --reason/--request and --dry-run', async () => {
    const call = await run([
      'session',
      'continue',
      '--pane',
      'tab-2:leaf-2',
      '--yes',
      '--reason',
      'unblock ads',
      '--request',
      'tell the ads session to go ahead',
      '--dry-run'
    ])
    expect(paramsOf(call, 'sessionManage.continue')).toEqual({
      target: { paneKey: 'tab-2:leaf-2' },
      answer: { kind: 'yes' },
      reason: 'unblock ads',
      request: 'tell the ads session to go ahead',
      dryRun: true
    })
  })

  it('takes exactly one of --yes, --choose and --prompt', async () => {
    await expect(
      run(['session', 'continue', '--pane', 'p', '--yes', '--choose', '2'])
    ).rejects.toThrow('exactly one of')
    await expect(run(['session', 'continue', '--pane', 'p'])).rejects.toThrow('exactly one of')
    const call = await run(['session', 'continue', '--pane', 'p', '--prompt', 'Run the tests'])
    expect(paramsOf(call, 'sessionManage.continue')).toMatchObject({
      answer: { kind: 'prompt', text: 'Run the tests' }
    })
  })

  it('never defaults to the session it runs in', async () => {
    await expect(run(['session', 'continue', '--yes'])).rejects.toThrow('Name the session')
    await expect(run(['session', 'stop'])).rejects.toThrow('Name the session')
    await expect(run(['session', 'restart'])).rejects.toThrow('Name the session')
  })
})

describe('omni session ask', () => {
  it('sends the Keep going precondition to the owner', async () => {
    const call = await run(
      ['session', 'ask', '--pane', 'p', '--question', 'Status?', '--require-keep-going-off'],
      {
        outcome: 'answered',
        reply: 'Working.',
        summary: 'answered',
        dryRun: false
      }
    )
    expect(paramsOf(call, 'sessionManage.ask')).toMatchObject({ requireKeepGoingOff: true })
  })

  it('waits past the question timeout and exits non-zero without an answer', async () => {
    const call = await run(
      ['session', 'ask', '--pane', 'p', '--question', 'Status?', '--timeout-ms', '2000'],
      { outcome: 'timeout', question: 'withdrawn', summary: 'No answer in time', dryRun: false }
    )
    expect(call).toHaveBeenCalledWith(
      'sessionManage.ask',
      { target: { paneKey: 'p' }, question: 'Status?', timeoutMs: 2000 },
      { timeoutMs: 17_000 }
    )
    expect(process.exitCode).toBe(1)
  })

  it('exits zero with the answer', async () => {
    await run(['session', 'ask', '--pane', 'p', '--question', 'Status?'], {
      outcome: 'answered',
      reply: 'All green.',
      summary: 'answered',
      dryRun: false
    })
    expect(process.exitCode).toBe(ORIGINAL_EXIT_CODE)
  })
})

describe('omni session answer', () => {
  const fingerprint = 'a'.repeat(64)

  it.each(['true', 'false'])('refuses assigned dry-run=%s for answers', async (value) => {
    await expect(
      run([
        'session',
        'answer',
        '--pane',
        'p',
        '--allow',
        '--expect',
        fingerprint,
        `--dry-run=${value}`
      ])
    ).rejects.toThrow('Pass --dry-run without a value')
  })

  it('requires the fingerprint, one answer, and an explicit target', async () => {
    await expect(run(['session', 'answer', '--pane', 'p', '--allow'])).rejects.toThrow('expect')
    await expect(
      run(['session', 'answer', '--pane', 'p', '--allow', '--deny', '--expect', fingerprint])
    ).rejects.toThrow('exactly one')
    await expect(run(['session', 'answer', '--allow', '--expect', fingerprint])).rejects.toThrow(
      'Name the session'
    )
    await expect(
      run(['session', 'answer', '--pane', 'p', '--expect', fingerprint])
    ).rejects.toThrow('exactly one')
  })

  it.each([
    [['--allow'], { kind: 'allow' }],
    [['--deny'], { kind: 'deny' }],
    [['--choose', '2'], { kind: 'choose', choice: 2 }],
    [['--text', 'Use the parser'], { kind: 'text', text: 'Use the parser' }]
  ] as const)('sends the answer and provenance for %s', async (flags, answer) => {
    const call = await run([
      'session',
      'answer',
      '--pane',
      'p',
      ...flags,
      '--expect',
      fingerprint,
      '--reason',
      'safe inspection',
      '--request',
      'unblock it',
      '--dry-run'
    ])
    expect(paramsOf(call, 'sessionManage.answer')).toEqual({
      target: { paneKey: 'p' },
      answer,
      expect: fingerprint,
      reason: 'safe inspection',
      request: 'unblock it',
      dryRun: true
    })
  })

  it('exits non-zero when terminal delivery cannot be confirmed', async () => {
    await run(['session', 'answer', '--pane', 'p', '--allow', '--expect', fingerprint], {
      delivery: 'unconfirmed'
    })
    expect(process.exitCode).toBe(1)
  })

  it('pins --terminal to the exact split pane and handle without a tab fallback', async () => {
    const leafId = '11111111-1111-4111-8111-111111111111'
    const call = vi.fn(async (method: string) => ({
      result:
        method === 'terminal.show'
          ? { terminal: { tabId: 'tab-1', leafId } }
          : { delivery: 'recorded' }
    }))
    const flags = parseArgs([
      'session',
      'answer',
      '--terminal',
      'term_1',
      '--deny',
      '--expect',
      fingerprint
    ]).flags
    await SESSION_MANAGE_HANDLERS['session answer']!({
      flags,
      json: true,
      cwd: '/tmp',
      client: { call, isRemote: false } as unknown as RuntimeClient
    })
    expect(paramsOf(call, 'sessionManage.answer')).toMatchObject({
      target: { paneKey: `tab-1:${leafId}`, terminal: 'term_1' }
    })
    call.mockResolvedValueOnce({ result: { terminal: { tabId: 'tab-1', leafId: 'unknown' } } })
    await expect(
      SESSION_MANAGE_HANDLERS['session answer']!({
        flags,
        json: true,
        cwd: '/tmp',
        client: { call, isRemote: false } as unknown as RuntimeClient
      })
    ).rejects.toThrow('exact pane')
  })

  it('documents refusals and never choosing persistent approval', () => {
    const spec = COMMAND_SPECS.find((entry) => entry.path.join(' ') === 'session answer')!
    expect(spec.usage).toContain('--expect <fingerprint>')
    expect(spec.notes?.join(' ')).toContain("don't ask again")
    expect(spec.notes?.join(' ')).toContain('unknown')
    expect(spec.notes?.join(' ')).toContain('hard stop')
  })
})

describe('omni session list / rename / conflicts', () => {
  it('names the execution host and bounds an empty result to the sidebar', () => {
    expect(
      formatSessionList({
        sessions: [{ hostId: 'ssh:box', pendingSteps: [] } as unknown as SessionManageEntry]
      })
    ).toContain('host ssh:box')
    const empty = formatSessionList({
      sessions: [],
      scope: { source: 'controller-sidebar', includeArchived: true }
    })
    expect(empty).toContain('No matching conversations in this controller’s sidebar')
    expect(empty).toContain('Archived rows included')
    expect(empty).toContain('transcript history are outside')
  })
  it('passes exact host and literal query filters and refuses ambiguous host syntax', async () => {
    const call = await run(
      ['session', 'list', '--host', 'ssh:box/one', '--query', '  Marketing Budget  '],
      { sessions: [] }
    )
    // Why parity: `omni session list` is the one caller that exports the parity population (C5).
    expect(paramsOf(call, 'sessionManage.list')).toEqual({
      hostId: 'ssh:box%2Fone',
      query: 'Marketing Budget',
      parity: true
    })
    await expect(run(['session', 'list', '--host', 'mw0002'], { sessions: [] })).rejects.toThrow(
      'Use --host'
    )
    await expect(run(['session', 'list', '--query', '  '], { sessions: [] })).rejects.toThrow(
      '1–256'
    )
  })
  it("passes --project and shows each thread's project status and the project chat", async () => {
    const call = await run(['session', 'list', '--project', 'OmniRogue / Ads'], { sessions: [] })
    expect(paramsOf(call, 'sessionManage.list')).toEqual({
      project: 'OmniRogue / Ads',
      parity: true
    })
    const project = { folderId: 'f', name: 'Ads', path: 'OmniRogue / Ads' }
    const text = formatSessionList({
      sessions: [
        { pendingSteps: [], projectStatus: 'reviewReady' },
        { pendingSteps: [], projectStatus: null, projectCoordinator: true }
      ] as unknown as SessionManageEntry[],
      scope: { source: 'controller-sidebar', includeArchived: false, project }
    })
    expect(text).toContain('project: ready for review')
    expect(text).toContain('project chat')
    expect(text).toContain('threads of the project “OmniRogue / Ads”')
    expect(
      formatSessionList({
        sessions: [],
        scope: { source: 'controller-sidebar', includeArchived: false, project }
      })
    ).toContain('No matching threads in “OmniRogue / Ads”')
  })

  it('validates --state and passes the filters', async () => {
    await expect(run(['session', 'list', '--state', 'sleeping'])).rejects.toThrow('Unknown --state')
    const call = await run(
      ['session', 'list', '--state', 'idle,exited', '--folder', 'Ads', '--include-archived'],
      { sessions: [] }
    )
    expect(paramsOf(call, 'sessionManage.list')).toEqual({
      states: ['idle', 'exited'],
      folder: 'Ads',
      includeArchived: true,
      parity: true
    })
  })

  it('lists only Stalled sessions for --state stalled, alone or with states, filtering here', async () => {
    const sessions = [
      { paneKey: 'a', state: 'idle', stalled: { at: 1, reason: 'its reply ends on a question' } },
      { paneKey: 'b', state: 'idle' },
      { paneKey: 'c', state: 'exited' }
    ]
    const log = vi.mocked(console.log)
    const call = await run(['session', 'list', '--state', 'stalled'], { sessions })
    expect(paramsOf(call, 'sessionManage.list')).toEqual({ parity: true })
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string).result.sessions).toEqual([sessions[0]])
    const both = await run(['session', 'list', '--state', 'stalled,exited'], { sessions })
    expect(paramsOf(both, 'sessionManage.list')).toEqual({ parity: true })
    expect(
      JSON.parse(log.mock.calls.at(-1)![0] as string).result.sessions.map(
        (entry: { paneKey: string }) => entry.paneKey
      )
    ).toEqual(['a', 'c'])
    expect(
      formatSessionList({
        sessions: [
          {
            ...sessions[0],
            pendingSteps: [],
            waitedOnBy: ['tab-9:leaf-1']
          } as unknown as SessionManageEntry
        ]
      })
    ).toContain('  stalled: its reply ends on a question\n  waited on by: tab-9:leaf-1')
  })

  // Session parity (step 8): which list a conversation is on, and the unfiltered population.
  it('prints each entry’s bucket and the parity population, and an older host’s list as before', () => {
    const entry = {
      paneKey: 'tab-1:leaf-1',
      hostId: 'runtime:env-studio',
      pendingSteps: []
    } as unknown as SessionManageEntry
    const older = formatSessionList({ sessions: [entry] })
    expect(older).not.toContain('bucket')
    expect(older).not.toContain('Parity population')
    const text = formatSessionList({
      sessions: [
        { ...entry, bucket: 'ownerListed', verification: 'verified', rest: 'asleep' },
        {
          ...entry,
          paneKey: 'tab-2:leaf-1',
          bucket: 'receiverOnly',
          verification: 'unverified',
          bucketReason: 'absence-unverified'
        }
      ] as SessionManageEntry[],
      parity: {
        rows: [],
        countsByHost: [
          {
            hostId: 'runtime:env-studio',
            count: 9,
            ownerListed: 7,
            heldByOwner: 1,
            receiverOnly: 1,
            workflow: 0,
            unverified: 1,
            stale: 0,
            archived: 3
          }
        ],
        ownerLedgers: [
          {
            hostId: 'runtime:env-studio',
            generation: 'gen-1',
            revision: 3,
            source: 'main',
            state: 'stale',
            asOf: Date.UTC(2026, 9, 6, 21, 0, 0)
          }
        ]
      }
    })
    expect(text).toContain(
      'pane tab-1:leaf-1  host runtime:env-studio  bucket ownerListed, asleep on its owner'
    )
    expect(text).toContain(
      'pane tab-2:leaf-1  host runtime:env-studio  bucket receiverOnly (unverified: absence-unverified)'
    )
    expect(text).toContain('Parity population (every sidebar row, before filters): 0 rows')
    expect(text).toContain(
      "  runtime:env-studio: 9 — 7 owner-listed, 1 held by owner, 1 only here (1 can't verify, 3 archived)"
    )
    expect(text).toContain(
      '  runtime:env-studio: ledger as of 2026-10-06T21:00:00.000Z (restored, not confirmed live)'
    )
  })

  it('renames the session it runs in by default', async () => {
    const call = await run(['session', 'rename', '--title', 'Parser fix'])
    expect(paramsOf(call, 'sessionManage.rename')).toEqual({
      target: { paneKey: 'tab-9:leaf-9' },
      title: 'Parser fix'
    })
  })

  it('passes whose words the title is, and refuses an origin it does not know', async () => {
    const call = await run([
      'session',
      'rename',
      '--title',
      'Ads: Q4 headlines',
      '--origin',
      'yours',
      '--reason',
      'the person named it'
    ])
    expect(paramsOf(call, 'sessionManage.rename')).toEqual({
      target: { paneKey: 'tab-9:leaf-9' },
      title: 'Ads: Q4 headlines',
      origin: 'yours',
      reason: 'the person named it'
    })
    await expect(run(['session', 'rename', '--title', 'X', '--origin', 'mine'])).rejects.toThrow(
      '--origin must be yours'
    )
  })
})

describe('--dry-run on the existing folder and session commands', () => {
  it.each([
    [['session', 'archive', '--pane', 'p', '--dry-run']],
    [['session', 'move', '--pane', 'p', '--unfile', '--dry-run']],
    [['session', 'delete', '--pane', 'p', '--dry-run', '--request', 'delete the dead ones']],
    [['folder', 'move', '--folder', 'Sales', '--top', '--dry-run']],
    [['folder', 'delete', '--folder', 'Old', '--dry-run', '--reason', 'tidy']]
  ])('passes dryRun and provenance for %j', async (argv) => {
    const call = await run(argv)
    expect(paramsOf(call, 'sessionFolders.mutate')).toMatchObject({ dryRun: true })
  })
})

describe('agent discovery and pane evidence', () => {
  it('lists every new session command in omni agent-context', () => {
    const commands = buildAgentContext(COMMAND_SPECS).commands.map((command) => command.command)
    for (const command of [
      'session list',
      'session continue',
      'session ask',
      'session stop',
      'session restart',
      'session rename',
      'session conflicts'
    ]) {
      expect(commands).toContain(command)
    }
    const archive = buildAgentContext(COMMAND_SPECS).commands.find(
      (command) => command.command === 'session archive'
    )
    expect(archive?.flags).toEqual(expect.arrayContaining(['dry-run', 'reason', 'request']))
  })

  it('attaches the acting pane’s launch evidence to session management calls only', () => {
    const inherited = {
      compatibilityInvocationId: 'inv',
      orchestrationCompatibilityEvidence: { paneKey: 'tab-9:leaf-9', launchToken: 'secret' }
    }
    for (const method of [
      'sessionManage.continue',
      'sessionManage.ask',
      'sessionManage.answer',
      'sessionFolders.mutate'
    ]) {
      expect(runtimeCompatibilityEnvelope(method, inherited)).toMatchObject({
        orchestrationCompatibilityEvidence: { paneKey: 'tab-9:leaf-9' }
      })
    }
    for (const method of [
      'promptQueue.enqueue',
      'nextSteps.decide',
      'sessionFolders.list',
      'terminal.send'
    ]) {
      expect(runtimeCompatibilityEnvelope(method, inherited)).toEqual({})
    }
  })
})
