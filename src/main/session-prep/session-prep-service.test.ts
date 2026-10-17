import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SESSION_PREP_BIG_BATCH, SESSION_PREP_CONCURRENCY } from '../../shared/session-prep-types'
import type {
  GateVerdict,
  PlannedItem,
  PreparedFields,
  SessionPrepSteps
} from '../../shared/session-prep-types'
import type { SessionPrepHost } from './session-prep-host'
import { SessionPrepService } from './session-prep-service'
import { createSessionPrepSteps } from './session-prep-steps'
import { renderDirectPrompt } from '../../shared/session-prep-prompt'
import { SessionPrepAccountPreparationError } from './session-prep-ids'
import { SessionPrepStore } from './session-prep-store'
import type { SessionPrepBatchRecord, SessionPrepItemRecord } from './session-prep-records'

const SOURCE = { worktreeId: 'repo-1::/src', paneKey: 'pane-1', agent: 'codex' as const }
const PASS: GateVerdict = {
  pass: true,
  failures: [],
  ask: null,
  scores: {},
  judge: 'deterministic'
}
const FAIL: GateVerdict = {
  pass: false,
  failures: [{ code: 'not-ready', detail: 'thin' }],
  ask: null,
  scores: { ready: 0.1 },
  judge: 'jev'
}

function planned(over: Partial<PlannedItem> = {}): PlannedItem {
  return {
    title: 'Fix login',
    ask: 'fix the login',
    anchor: 'fix the login',
    direct: false,
    changesCode: true,
    ...over
  }
}

function fieldsFor(item: PlannedItem, over: Partial<PreparedFields> = {}): PreparedFields {
  return {
    title: item.title,
    outcome: item.ask,
    doneWhen: ['tests pass', 'review done'],
    decided: [],
    references: [],
    constraints: [],
    assumptions: [],
    blockingQuestion: null,
    changesCode: item.changesCode,
    ...over
  }
}

function steps(over: Partial<SessionPrepSteps> = {}): SessionPrepSteps {
  return {
    plan: async () => ({ items: [planned()], dropped: [] }),
    prepare: async ({ item }) => fieldsFor(item),
    revise: async ({ fields }) => ({ ...fields, outcome: `${fields.outcome} revised` }),
    gate: async () => PASS,
    render: ({ fields, unresolved }) =>
      `RENDER:${fields.outcome}:${unresolved.map((entry) => entry.code).join(',')}`,
    renderDirect: ({ item, note, ask }) =>
      `DIRECT:${item.ask}:${note ?? ''}${ask ? `:ASK:${ask.question}` : ''}`,
    ...over
  }
}

function host(over: Partial<SessionPrepHost> = {}): SessionPrepHost & {
  worktrees: { repoId: string; name: string; agent: string; prompt: string }[]
  sessions: { worktreeId: string; agent: string; prompt: string }[]
  remember(repoId: string, name: string, id: string): void
} {
  const worktrees: { repoId: string; name: string; agent: string; prompt: string }[] = []
  const sessions: { worktreeId: string; agent: string; prompt: string }[] = []
  const existing = new Map<string, string>()
  return {
    worktrees,
    sessions,
    resolveWorktree: async () => ({
      path: '/src',
      repoId: 'repo-1',
      isFolder: false,
      isRemote: false
    }),
    listRepos: () => [
      {
        selector: 'id:repo-1',
        name: 'App',
        id: 'repo-1',
        path: '/src',
        isFolder: false,
        isRemote: false
      }
    ],
    resolveRepo: (selector) =>
      selector === 'id:repo-1'
        ? {
            selector,
            name: 'App',
            id: 'repo-1',
            path: '/src',
            isFolder: false,
            isRemote: false
          }
        : null,
    createWorktreeWithAgent: async (args) => {
      worktrees.push(args)
      return { worktreeId: `repo-1::/wt/${args.name}` }
    },
    createAgentSessionIn: async (args) => {
      sessions.push(args)
    },
    worktreeExistsByName: async (repoId, name) => existing.has(`${repoId}:${name}`),
    findWorktreeIdByName: async (repoId, name) => existing.get(`${repoId}:${name}`) ?? null,
    isAgentEnabled: (agent) => agent === 'claude' || agent === 'codex',
    fileSession: async ({ folder }) => ({
      path: typeof folder === 'string' ? folder : folder.path
    }),
    createBatchFolder: async () => ({ id: 'batch-folder', path: 'Launch' }),
    ...over,
    remember(repoId: string, name: string, id: string) {
      existing.set(`${repoId}:${name}`, id)
    }
  }
}

async function service(opts?: {
  steps?: SessionPrepSteps
  host?: ReturnType<typeof host>
  now?: () => number
}) {
  const store = new SessionPrepStore(await mkdtemp(join(tmpdir(), 'session-prep-svc-')))
  const usedHost = opts?.host ?? host()
  const usedSteps = opts?.steps ?? steps()
  const instance = new SessionPrepService({
    host: usedHost,
    steps: () => usedSteps,
    store,
    now: opts?.now ?? (() => 1_700_000_000_000)
  })
  await instance.start()
  return { service: instance, host: usedHost, store }
}

async function settled(
  instance: SessionPrepService,
  batchId: string,
  states: string[] = ['done', 'failed', 'cancelled', 'awaiting-confirm']
) {
  // Why 20s: every step persists with fsync, which a loaded CI runner can stretch past 2s.
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    const view = instance.get(batchId)
    if (states.includes(view.state)) {
      return view
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`batch still ${instance.get(batchId).state}`)
}

describe('SessionPrepService', () => {
  it('ends each brief with the batch template unless the item named its own', async () => {
    const store = new SessionPrepStore(await mkdtemp(join(tmpdir(), 'session-prep-svc-')))
    const used = host()
    const plan = vi.fn(async (_input: Parameters<SessionPrepSteps['plan']>[0]) => ({
      items: [
        planned({ title: 'One', direct: true, changesCode: false }),
        planned({
          title: 'Two',
          direct: true,
          changesCode: false,
          choices: { agentTemplate: 'researcher' }
        })
      ],
      dropped: []
    }))
    const instance = new SessionPrepService({
      host: used,
      steps: () => steps({ plan }),
      store,
      now: () => 1_700_000_000_000,
      agentTemplates: () => ({ overrides: { reviewer: { instructions: 'REVIEW ONLY' } } })
    })
    await instance.start()
    const { batchId } = instance.request({
      text: 'create two sessions',
      source: SOURCE,
      context: '',
      agentTemplateId: 'reviewer'
    })
    await settled(instance, batchId)
    expect(plan.mock.calls[0]?.[0]).toMatchObject({
      agentTemplates: expect.arrayContaining([{ id: 'reviewer', name: 'Reviewer' }])
    })
    const prompts = used.sessions.map((entry) => entry.prompt)
    expect(prompts[0]).toBe(
      'DIRECT:fix the login:\n\n---\n\nStanding instructions for this session (agent template "Reviewer"; follow them throughout):\nREVIEW ONLY'
    )
    expect(prompts[1]).toMatch(
      /^DIRECT:fix the login:\n\n---\n\nStanding[^\n]*"Researcher"[^\n]*\n# Researcher/
    )
    const view = instance.get(batchId)
    expect(view.items.map((entry) => entry.agentTemplate)).toEqual(['Reviewer', 'Researcher'])
  })

  it.each([
    new Error('Failed to authenticate: OAuth session expired'),
    new SessionPrepAccountPreparationError('Account routing unavailable')
  ])('stops the splitter-to-preparer chain on account failure: %s', async (refusal) => {
    const runText = vi.fn().mockRejectedValue(refusal)
    const { service: instance, host: used } = await service({
      steps: createSessionPrepSteps({ runText, pathExists: async () => true })
    })
    const { batchId } = instance.request({
      text: 'create a login session',
      source: SOURCE,
      context: ''
    })
    const view = await settled(instance, batchId)
    expect(view.state).toBe('failed')
    expect(view.items).toHaveLength(0)
    expect(runText).toHaveBeenCalledTimes(1)
    expect(used.worktrees).toHaveLength(0)
    expect(used.sessions).toHaveLength(0)
  })

  it.each(['gate', 'revise'] as const)('does not launch after %s auth refusal', async (stage) => {
    const refusal = new Error('Failed to authenticate: OAuth session expired')
    const gate = vi.fn().mockImplementation(async () => {
      if (stage === 'gate') {
        throw refusal
      }
      return FAIL
    })
    const revise = vi.fn().mockRejectedValue(refusal)
    const { service: instance, host: used } = await service({ steps: steps({ gate, revise }) })
    const { batchId } = instance.request({
      text: 'create a login session',
      source: SOURCE,
      context: ''
    })
    const view = await settled(instance, batchId)
    expect(view.items[0]?.state).toBe('failed')
    expect(gate).toHaveBeenCalledTimes(1)
    expect(revise).toHaveBeenCalledTimes(stage === 'revise' ? 1 : 0)
    expect(used.worktrees).toHaveLength(0)
    expect(used.sessions).toHaveLength(0)
  })

  it('plans, prepares, gates, and launches a code-changing item in a new workspace', async () => {
    const { service: instance, host: used } = await service()
    const { batchId } = instance.request({
      text: 'create a session to fix the login',
      source: SOURCE,
      context: ''
    })
    const view = await settled(instance, batchId)
    expect(view.state).toBe('done')
    expect(view.items[0]?.state).toBe('launched')
    expect(view.items[0]?.launched?.newWorkspace).toBe(true)
    expect(used.worktrees).toHaveLength(1)
    expect(used.worktrees[0]?.agent).toBe('codex')
    expect(used.worktrees[0]?.prompt).toContain('RENDER:')
    expect(used.sessions).toHaveLength(0)
  })

  it('repairs a failed gate then launches the revised prompt', async () => {
    let checks = 0
    const { service: instance, host: used } = await service({
      steps: steps({
        gate: async () => {
          checks += 1
          return checks === 1 ? FAIL : PASS
        }
      })
    })
    const { batchId } = instance.request({
      text: 'create sessions for login',
      source: SOURCE,
      context: ''
    })
    const view = await settled(instance, batchId)
    expect(view.items[0]?.repairs).toBe(1)
    expect(used.worktrees[0]?.prompt).toContain('revised')
  })

  it('launches with unresolved findings after the repair limit', async () => {
    const { service: instance, host: used } = await service({
      steps: steps({ gate: async () => FAIL })
    })
    const { batchId } = instance.request({
      text: 'create sessions for login',
      source: SOURCE,
      context: ''
    })
    const view = await settled(instance, batchId)
    expect(view.items[0]?.repairs).toBe(2)
    expect(used.worktrees[0]?.prompt).toContain('not-ready')
  })

  it('launches the person’s words when prepare fails twice', async () => {
    const { service: instance, host: used } = await service({
      steps: steps({
        prepare: async () => {
          throw new Error('workspace unreadable')
        }
      })
    })
    const { batchId } = instance.request({
      text: 'create sessions for login',
      source: SOURCE,
      context: ''
    })
    const view = await settled(instance, batchId)
    expect(view.items[0]?.note).toMatch(/Launched with your own words: preparation failed/)
    expect(used.worktrees[0]?.prompt).toContain('DIRECT:')
  })

  it('fails instead of launching when the Claude sign-in expired', async () => {
    let calls = 0
    const { service: instance, host: used } = await service({
      steps: steps({
        prepare: async () => {
          calls += 1
          throw new Error(
            'Claude CLI command failed with code 1: Permission allow rule (../../../.claude/settings.json): Bash(python3 * spec/assemble.py *) has a wildcard before the rest of the command, so it also matches any options inserted at that position. Failed to authenticate: OAuth session expired and could not be refreshed'
          )
        }
      })
    })
    const { batchId } = instance.request({
      text: 'create sessions for login',
      source: SOURCE,
      context: ''
    })
    const view = await settled(instance, batchId)
    expect(calls).toBe(1)
    expect(view.items[0]?.state).toBe('failed')
    expect(view.items[0]?.note).toContain('Failed to authenticate: OAuth session expired')
    expect(view.items[0]?.note).toContain('Sign in again')
    expect(used.worktrees).toHaveLength(0)
    expect(used.sessions).toHaveLength(0)
  })

  it.each([true, false])(
    'preserves split scope when direct is %s and preparation otherwise fails',
    async (direct) => {
      const items = [
        planned({ title: 'Login', ask: 'Fix the login timeout', direct, changesCode: false }),
        planned({ title: 'Guide', ask: 'Write the onboarding guide', direct, changesCode: false })
      ]
      const { service: instance, host: used } = await service({
        steps: steps({
          plan: async () => ({ items, dropped: [] }),
          prepare: async () => {
            throw new Error('workspace unreadable')
          },
          renderDirect: renderDirectPrompt
        })
      })
      const text = 'Fix the login timeout and write the onboarding guide'
      const { batchId } = instance.request({ text, source: SOURCE, context: '' })
      expect((await settled(instance, batchId)).state).toBe('done')
      expect(used.sessions).toHaveLength(2)
      for (const [index, item] of items.entries()) {
        const prompt = used.sessions.find((session) =>
          session.prompt.includes(`This session covers: ${item.ask}.`)
        )?.prompt
        expect(prompt?.startsWith(`${text}\n\n`)).toBe(true)
        expect(prompt).toContain(
          `Sibling sessions in the same batch handle: ${items[1 - index].title}. Do not do their work.`
        )
        if (!direct) {
          expect(prompt).toContain('Launched with your own words: preparation failed')
        }
      }
    }
  )

  it('launches a direct item without preparation', async () => {
    const prepare = vi.fn()
    const { service: instance, host: used } = await service({
      steps: steps({
        plan: async () => ({ items: [planned({ direct: true, changesCode: false })], dropped: [] }),
        prepare
      })
    })
    const { batchId } = instance.request({
      text: 'create a session to ping staging',
      source: SOURCE,
      context: ''
    })
    await settled(instance, batchId)
    expect(prepare).not.toHaveBeenCalled()
    expect(used.sessions).toHaveLength(1)
    expect(used.sessions[0]?.prompt).toContain('DIRECT:')
  })

  it('switches the launch agent to claude when the gate asks the person', async () => {
    const { service: instance, host: used } = await service({
      steps: steps({
        gate: async () => ({
          ...PASS,
          ask: { question: 'Which env?', options: ['prod', 'dev'] }
        })
      })
    })
    const { batchId } = instance.request({
      text: 'create sessions for login',
      source: SOURCE,
      context: ''
    })
    await settled(instance, batchId)
    expect(used.worktrees[0]?.agent).toBe('claude')
  })

  it('holds a big batch until confirm', async () => {
    const items = Array.from({ length: SESSION_PREP_BIG_BATCH + 1 }, (_, index) =>
      planned({ title: `Item ${index}` })
    )
    const { service: instance, host: used } = await service({
      steps: steps({ plan: async () => ({ items, dropped: [] }) })
    })
    const { batchId } = instance.request({
      text: 'create sessions for a,b,c',
      source: SOURCE,
      context: ''
    })
    const waiting = await settled(instance, batchId, ['awaiting-confirm'])
    expect(waiting.state).toBe('awaiting-confirm')
    expect(used.worktrees).toHaveLength(0)
    await instance.confirm(batchId)
    const done = await settled(instance, batchId)
    expect(done.state).toBe('done')
    expect(done.items).toHaveLength(SESSION_PREP_BIG_BATCH + 1)
  })

  it('cancels items that have not launched', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const { service: instance, host: used } = await service({
      steps: steps({
        prepare: async ({ item }) => {
          await held
          return fieldsFor(item)
        }
      })
    })
    const { batchId } = instance.request({
      text: 'create sessions for login',
      source: SOURCE,
      context: ''
    })
    await vi.waitFor(() => expect(instance.get(batchId).items[0]?.state).toBe('preparing'), {
      timeout: 20_000
    })
    const cancelled = await instance.cancel(batchId)
    expect(cancelled.state).toBe('cancelled')
    release()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(used.worktrees).toHaveLength(0)
    expect(instance.get(batchId).items[0]?.state).toBe('cancelled')
  })

  it('runs a stated order as one session that does the parts in sequence', async () => {
    const asks: string[] = []
    const { service: instance } = await service({
      steps: steps({
        plan: async () => ({
          items: [
            planned({ title: 'First' }),
            planned({ title: 'Second', after: [0], changesCode: false })
          ],
          dropped: []
        }),
        prepare: async ({ item }) => {
          asks.push(item.ask)
          return fieldsFor(item)
        }
      })
    })
    const { batchId } = instance.request({
      text: 'create sessions in order',
      source: SOURCE,
      context: ''
    })
    const view = await settled(instance, batchId)
    expect(view.items).toHaveLength(1)
    expect(view.items[0]?.state).toBe('launched')
    expect(asks).toHaveLength(1)
    expect(asks[0]).toContain('Then, once that is done:')
  })

  it('lets an item already launching finish when the batch is cancelled', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const used = host()
    const create = used.createWorktreeWithAgent
    used.createWorktreeWithAgent = async (args) => {
      await held
      return create(args)
    }
    const { service: instance } = await service({ host: used })
    const { batchId } = instance.request({
      text: 'create sessions for login',
      source: SOURCE,
      context: ''
    })
    await vi.waitFor(() => expect(instance.get(batchId).items[0]?.state).toBe('launching'), {
      timeout: 20_000
    })
    const cancelled = await instance.cancel(batchId)
    expect(cancelled.state).toBe('running')
    expect(cancelled.items[0]?.state).toBe('launching')
    release()
    const view = await settled(instance, batchId)
    expect(view.state).toBe('done')
    expect(view.items[0]?.state).toBe('launched')
    expect(used.worktrees).toHaveLength(1)
  })

  it('launches the person’s words when the final check cannot run', async () => {
    const { service: instance, host: used } = await service({
      steps: steps({
        gate: async () => {
          throw new Error('judge offline')
        }
      })
    })
    const { batchId } = instance.request({
      text: 'create sessions for login',
      source: SOURCE,
      context: ''
    })
    const view = await settled(instance, batchId)
    expect(view.items[0]?.state).toBe('launched')
    expect(view.items[0]?.note).toMatch(/the final check could not run \(judge offline\)/)
    expect(used.worktrees[0]?.prompt).toMatch(/^DIRECT:/)
  })

  it('launches the person’s words, keeping the question, when a contradiction survives repair', async () => {
    const contradiction: GateVerdict = {
      pass: false,
      failures: [{ code: 'contradiction', detail: 'conflicts with the request' }],
      ask: { question: 'Which plan name?', options: [] },
      scores: { consistent: 0.1 },
      judge: 'jev'
    }
    const { service: instance, host: used } = await service({
      steps: steps({ gate: async () => contradiction })
    })
    const { batchId } = instance.request({
      text: 'create sessions for login',
      source: SOURCE,
      context: ''
    })
    const view = await settled(instance, batchId)
    expect(view.items[0]?.repairs).toBe(2)
    expect(view.items[0]?.note).toMatch(/kept failing a check \(conflicts with the request\)/)
    expect(used.worktrees[0]?.prompt).toMatch(/^DIRECT:.*:ASK:Which plan name\?$/)
    expect(used.worktrees[0]?.agent).toBe('claude')
  })

  it('fails only the batch it cannot resume and resumes the rest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'session-prep-resume-many-'))
    const store = new SessionPrepStore(directory)
    const used = host({
      worktreeExistsByName: async () => {
        throw new Error('repository is gone')
      }
    })
    const broken = launchingRecord('worktree')
    const healthy = { ...launchingRecord('session'), id: 'sp_resume2' }
    store.upsert(broken)
    store.upsert(healthy)
    await store.persist()
    const instance = new SessionPrepService({ host: used, steps: () => steps(), store })
    await instance.start()
    const failed = await settled(instance, broken.id)
    expect(failed.state).toBe('failed')
    expect(failed.notes).toContain('Could not resume: repository is gone')
    const resumed = await settled(instance, healthy.id)
    expect(resumed.state).toBe('done')
    expect(resumed.items[0]?.note).toMatch(/Interrupted while launching/)
  })

  it('marks a launching worktree as launched on resume when the workspace exists', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'session-prep-resume-'))
    const store = new SessionPrepStore(directory)
    const used = host()
    used.remember('repo-1', 'rp-fix-login-test', 'repo-1::/existing')
    const record = launchingRecord('worktree')
    record.items[0]!.launch = {
      kind: 'worktree',
      name: 'rp-fix-login-test',
      startedAt: 1
    }
    store.upsert(record)
    await store.persist()
    const instance = new SessionPrepService({
      host: used,
      steps: () => steps(),
      store
    })
    await instance.start()
    await settled(instance, record.id)
    expect(used.worktrees).toHaveLength(0)
    expect(instance.get(record.id).items[0]?.state).toBe('launched')
    expect(store.get(record.id)?.items[0]?.launched).toMatchObject({
      worktreeId: 'repo-1::/existing',
      paneIdentity: 'unresolved-recovered'
    })
  })

  it('persists the created terminal handle before resolving its pane identity', async () => {
    let store: SessionPrepStore | undefined
    let batchId = ''
    let persistedHandle: string | undefined
    const used = host({
      createWorktreeWithAgent: async () => ({
        worktreeId: 'repo-1::/new-worktree',
        paneHandle: 'terminal-handle'
      }),
      resolveTerminalPaneKey: async (handle) => {
        persistedHandle = store?.get(batchId)?.items[0]?.launched?.paneHandle
        expect(handle).toBe('terminal-handle')
        return 'stable-pane-key'
      }
    })
    const created = await service({ host: used })
    store = created.store
    const request = created.service.request({
      text: 'create sessions for login in OmniRogue / Prototypes',
      source: SOURCE,
      context: '',
      defaultFolder: 'OmniRogue / Prototypes'
    })
    batchId = request.batchId
    await settled(created.service, batchId)
    expect(persistedHandle).toBe('terminal-handle')
    expect(store.get(batchId)?.items[0]?.launched).toMatchObject({
      paneKey: 'stable-pane-key',
      paneHandle: 'terminal-handle'
    })
  })

  it('resolves a persisted pending terminal handle before resuming sibling work', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'session-prep-resume-handle-'))
    const store = new SessionPrepStore(directory)
    const record = launchingRecord('worktree')
    record.items[0]!.state = 'launched'
    record.items[0]!.launched = {
      worktreeId: 'repo-1::/created',
      newWorkspace: true,
      at: 2,
      paneHandle: 'saved-terminal-handle',
      paneIdentity: 'pending'
    }
    record.items[0]!.launch = undefined
    store.upsert(record)
    await store.persist()
    const used = host({
      resolveTerminalPaneKey: vi.fn(async (handle) => {
        expect(handle).toBe('saved-terminal-handle')
        return 'recovered-stable-pane'
      })
    })
    const instance = new SessionPrepService({ host: used, steps: () => steps(), store })
    await instance.start()
    await settled(instance, record.id)
    expect(used.resolveTerminalPaneKey).toHaveBeenCalledWith('saved-terminal-handle')
    expect(store.get(record.id)?.items[0]?.launched).toMatchObject({
      paneKey: 'recovered-stable-pane',
      paneHandle: 'saved-terminal-handle'
    })
    expect(store.get(record.id)?.items[0]?.launched?.paneIdentity).toBeUndefined()
  })

  it('never infers a remote startup or launches a duplicate from a cached workspace on resume', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'session-prep-resume-ssh-'))
    const store = new SessionPrepStore(directory)
    const used = host()
    used.remember('repo-1', 'rp-fix-login-test', 'repo-1::/existing')
    const record = launchingRecord('worktree')
    record.items[0]!.executionTarget = {
      path: '/remote/project',
      repoId: 'repo-1',
      isFolder: false,
      isRemote: true,
      connectionId: 'ssh-worker',
      hostId: 'ssh:ssh-worker'
    }
    store.upsert(record)
    await store.persist()
    const instance = new SessionPrepService({ host: used, steps: () => steps(), store })
    await instance.start()
    const view = await settled(instance, record.id)
    expect(used.worktrees).toHaveLength(0)
    expect(view.items[0]?.state).toBe('failed')
    expect(view.items[0]?.launched).toBeUndefined()
    expect(view.items[0]?.note).toContain('SSH launch outcome is unverified')
  })

  it('fails a launching session on resume instead of duplicating it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'session-prep-resume-s-'))
    const store = new SessionPrepStore(directory)
    const used = host()
    const record = launchingRecord('session')
    store.upsert(record)
    await store.persist()
    const instance = new SessionPrepService({
      host: used,
      steps: () => steps(),
      store
    })
    await instance.start()
    const view = await settled(instance, record.id)
    expect(used.sessions).toHaveLength(0)
    expect(view.items[0]?.state).toBe('failed')
    expect(view.items[0]?.note).toMatch(/Interrupted while launching/)
  })
})

function launchingRecord(kind: 'worktree' | 'session'): SessionPrepBatchRecord {
  const item: SessionPrepItemRecord = {
    index: 0,
    planned: planned(),
    state: 'launching',
    verdicts: [PASS],
    repairs: 0,
    prompt: 'PROMPT',
    launch: {
      kind,
      name: kind === 'worktree' ? 'rp-fix-login-test' : undefined,
      operationId: kind === 'session' ? '1-abc' : undefined,
      startedAt: 1
    }
  }
  return {
    id: 'sp_resume1',
    createdAt: 1,
    updatedAt: 1,
    state: 'running',
    source: SOURCE,
    request: 'create sessions for login',
    context: '',
    dropped: [],
    items: [item]
  }
}

describe('shared preparation admission', () => {
  it('caps planners across independent batches and skips a cancelled queued objective', async () => {
    let active = 0
    let peak = 0
    const releases: (() => void)[] = []
    const plan = vi.fn(async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise<void>((resolve) => {
        releases.push(resolve)
      })
      active -= 1
      return { items: [], dropped: [] }
    })
    const { service: instance } = await service({ steps: steps({ plan }) })
    const batches = Array.from(
      { length: SESSION_PREP_CONCURRENCY + 2 },
      (_, index) =>
        instance.request({ text: `Objective ${index}`, context: '', source: SOURCE }).batchId
    )
    await vi.waitFor(() => expect(plan).toHaveBeenCalledTimes(SESSION_PREP_CONCURRENCY))
    await instance.cancel(batches[SESSION_PREP_CONCURRENCY + 1])
    releases.splice(0).forEach((release) => release())
    await vi.waitFor(() => expect(plan).toHaveBeenCalledTimes(SESSION_PREP_CONCURRENCY + 1))
    releases.splice(0).forEach((release) => release())
    await Promise.all(batches.map((batch) => settled(instance, batch)))
    expect(peak).toBe(SESSION_PREP_CONCURRENCY)
    expect(instance.get(batches[SESSION_PREP_CONCURRENCY + 1]).state).toBe('cancelled')
  })

  it('does not multiply preparation slots when several objectives decompose into items', async () => {
    let active = 0
    let peak = 0
    const tracked = async <T>(work: () => T): Promise<T> => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 15))
      try {
        return work()
      } finally {
        active -= 1
      }
    }
    const { service: instance, host: usedHost } = await service({
      steps: steps({
        plan: async () =>
          tracked(() => ({
            items: Array.from({ length: 4 }, (_, index) =>
              planned({
                title: `Task ${index}`,
                ask: `Task ${index}`,
                changesCode: false
              })
            ),
            dropped: []
          })),
        prepare: async ({ item }) => tracked(() => fieldsFor(item))
      })
    })
    const batches = Array.from(
      { length: 3 },
      (_, index) =>
        instance.request({ text: `Independent objective ${index}`, context: '', source: SOURCE })
          .batchId
    )
    await Promise.all(batches.map((batch) => settled(instance, batch)))
    expect(peak).toBeLessThanOrEqual(SESSION_PREP_CONCURRENCY)
    expect(usedHost.sessions).toHaveLength(12)
  })
})
