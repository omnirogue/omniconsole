import { SESSION_PREP_BIG_BATCH } from '../../shared/session-prep-types'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type {
  GateVerdict,
  PlannedItem,
  SessionPrepBatchView,
  SessionPrepSteps
} from '../../shared/session-prep-types'
import type { SessionPrepHost } from './session-prep-host'
import { SessionPrepService } from './session-prep-service'
import { SessionPrepStore } from './session-prep-store'
import { emptyProjectSettings } from '../../shared/project-settings'
import { resolveProjectLaunch } from '../../shared/project-launch-inheritance'

const SOURCE = { worktreeId: 'repo-1::/src', paneKey: 'pane-1', agent: 'claude' as const }
const PASS: GateVerdict = {
  pass: true,
  failures: [],
  ask: null,
  scores: {},
  judge: 'deterministic'
}
const REPO = {
  selector: 'id:repo-1',
  name: 'App',
  id: 'repo-1',
  path: '/src',
  isFolder: false,
  isRemote: false
}

function planned(over: Partial<PlannedItem> = {}): PlannedItem {
  return {
    title: 'Prototype A',
    ask: 'build prototype A',
    anchor: 'prototype A',
    direct: false,
    changesCode: true,
    ...over
  }
}

function steps(items: PlannedItem[], effort?: 'low' | 'medium' | 'high'): SessionPrepSteps {
  return {
    plan: async () => ({ items, dropped: [] }),
    prepare: async ({ item }) => ({
      title: item.title,
      outcome: item.ask,
      doneWhen: ['a', 'b'],
      decided: [],
      references: [],
      constraints: [],
      assumptions: [],
      blockingQuestion: null,
      changesCode: item.changesCode,
      ...(effort ? { effort } : {})
    }),
    revise: async ({ fields }) => fields,
    gate: async () => PASS,
    render: ({ launch }) => `RENDER:${JSON.stringify(launch)}`,
    renderDirect: ({ launch }) => `DIRECT:${JSON.stringify(launch)}`
  }
}

type Call = Record<string, unknown>

function host(over: Partial<SessionPrepHost> = {}) {
  const worktrees: Call[] = []
  const sessions: Call[] = []
  const filed: Call[] = []
  const batchFolders: Parameters<SessionPrepHost['createBatchFolder']>[0][] = []
  const fake: SessionPrepHost = {
    resolveWorktree: async () => ({
      path: '/src',
      repoId: 'repo-1',
      isFolder: false,
      isRemote: false
    }),
    listRepos: () => [REPO],
    resolveRepo: (selector) => (selector === REPO.selector ? REPO : null),
    createWorktreeWithAgent: async (args) => {
      worktrees.push(args)
      return { worktreeId: `repo-1::/wt/${args.name}`, surface: { tabId: `tab-${args.name}` } }
    },
    createAgentSessionIn: async (args) => {
      sessions.push(args)
      return { tabId: 'tab-session', paneKey: null }
    },
    fileSession: async (args) => {
      filed.push(args)
      return {
        path: typeof args.folder === 'string' ? `Saved Sessions / ${args.folder}` : args.folder.path
      }
    },
    createBatchFolder: async (args) => {
      batchFolders.push(args)
      return { id: 'batch-folder-1', path: args.name(1) }
    },
    worktreeExistsByName: async () => false,
    findWorktreeIdByName: async () => null,
    isAgentEnabled: (agent) => agent === 'claude' || agent === 'codex',
    ...over
  }
  return { fake, worktrees, sessions, filed, batchFolders }
}

async function run(
  items: PlannedItem[],
  used: ReturnType<typeof host>,
  effort?: 'low' | 'medium' | 'high',
  until: string[] = ['done', 'failed', 'cancelled'],
  agentTemplateId?: string
): Promise<SessionPrepBatchView> {
  const store = new SessionPrepStore(await mkdtemp(join(tmpdir(), 'session-prep-launch-')))
  const instance = new SessionPrepService({
    host: used.fake,
    steps: () => steps(items, effort),
    store,
    now: () => 1_700_000_000_000
  })
  await instance.start()
  const { batchId } = instance.request({
    text: 'launch sessions for prototype A and B on codex, high effort, in OmniRogue / Prototypes',
    source: SOURCE,
    context: '',
    ...(agentTemplateId ? { agentTemplateId } : {})
  })
  // Why 20s: every step persists with fsync, which a loaded CI runner can stretch past 2s.
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    const view = instance.get(batchId)
    if (until.includes(view.state)) {
      return view
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('batch did not settle')
}

const CHOSEN = { agent: 'codex', effort: 'high', folder: 'OmniRogue / Prototypes' } as const

describe('session prep project agent selection', () => {
  it.each(['reviewer', 'project-only'])('delivers the selected project copy of %s', async (id) => {
    const instructions = 'Use the project-specific review checklist exactly.\nPreserve this line.'
    const project = {
      folderId: 'project',
      name: 'Project',
      settings: {
        ...emptyProjectSettings(1),
        agents: [
          {
            templateId: 'developer',
            name: 'First agent',
            digest: 'a'.repeat(12),
            instructions: 'DEFAULT MUST NOT APPEAR'
          },
          { templateId: id, name: 'Project reviewer', digest: 'b'.repeat(12), instructions }
        ]
      }
    }
    const selectedIds: (string | undefined)[] = []
    const used = host({
      projectLaunch: async ({ templateId }) => {
        selectedIds.push(templateId)
        return {
          ...resolveProjectLaunch({
            project,
            launch: [],
            session: [],
            removed: [],
            templateId: templateId ?? null,
            host: { hostId: 'local', label: 'Home', repoCheckout: () => null, skill: () => null }
          }),
          project: { folderId: project.folderId, name: project.name },
          host: { id: 'local', label: 'Home' }
        }
      }
    })
    const view = await run(
      [planned({ changesCode: false, choices: CHOSEN })],
      used,
      undefined,
      undefined,
      id
    )
    expect(view.items[0]?.state).toBe('launched')
    expect(selectedIds).toEqual([id])
    const prompt = String(used.sessions[0]?.prompt)
    expect(prompt).toContain(instructions)
    expect(prompt.split(instructions)).toHaveLength(2)
    expect(prompt).not.toContain('DEFAULT MUST NOT APPEAR')
    expect(prompt).not.toContain('# Reviewer')
    expect(view.items[0]?.agentTemplate).toBe('Project reviewer')
  })
})

describe('session prep launch choices', () => {
  it('launches on the chosen agent with model and effort, and files every session', async () => {
    const used = host()
    const view = await run(
      [
        planned({ choices: { ...CHOSEN, model: 'gpt-5.6-sol' } }),
        planned({ title: 'Prototype B', changesCode: false, choices: CHOSEN })
      ],
      used
    )
    expect(view.items.map((item) => item.state)).toEqual(['launched', 'launched'])
    expect(used.worktrees[0]).toMatchObject({
      batchId: view.id,
      agent: 'codex',
      launch: { model: 'gpt-5.6-sol', effort: 'high' }
    })
    expect(used.sessions[0]).toMatchObject({ agent: 'codex', launch: { effort: 'high' } })
    expect(String(used.worktrees[0]?.prompt)).toContain('"agent":"codex"')
    expect(used.filed).toEqual(
      expect.arrayContaining([
        {
          folder: 'OmniRogue / Prototypes',
          surface: { tabId: 'tab-session', paneKey: null },
          // The person's words travel with filing, for its recorded reason.
          request:
            'launch sessions for prototype A and B on codex, high effort, in OmniRogue / Prototypes'
        },
        expect.objectContaining({ folder: 'OmniRogue / Prototypes' })
      ])
    )
    expect(view.items[0]).toMatchObject({
      agent: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
      folder: 'Saved Sessions / OmniRogue / Prototypes'
    })
    expect(view.items[0]?.note).toContain('pane identity is unavailable')
  })

  it('attaches a verify gate to every prepared session it launched here, code or not', async () => {
    const verified: Parameters<NonNullable<SessionPrepHost['attachVerify']>>[0][] = []
    const used = host({
      createWorktreeWithAgent: async (args) => ({
        worktreeId: `repo-1::/wt/${args.name}`,
        surface: { tabId: `tab-${args.name}`, paneKey: `pane-${args.name}` }
      }),
      createAgentSessionIn: async () => ({ tabId: 'tab-session', paneKey: 'pane-session' }),
      attachVerify: async (args) => {
        verified.push(args)
        return { attached: true }
      }
    })
    const view = await run(
      [planned({ choices: CHOSEN }), planned({ title: 'Prototype B', changesCode: false })],
      used
    )
    for (let attempt = 0; attempt < 200 && verified.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(view.items.map((item) => item.state)).toEqual(['launched', 'launched'])
    expect(verified).toHaveLength(2)
    expect(verified.map((entry) => entry.title).sort()).toEqual(['Prototype A', 'Prototype B'])
    expect(verified.find((entry) => entry.title === 'Prototype A')).toMatchObject({
      doneWhen: ['a', 'b'],
      agent: 'codex',
      paneKey: expect.stringMatching(/^pane-/)
    })
  })

  it('still launches when filing fails, and says so on the item', async () => {
    const used = host({
      fileSession: async () => {
        throw new Error('The OmniConsole window is not open')
      }
    })
    const view = await run([planned({ changesCode: false, choices: CHOSEN })], used)
    expect(view.items[0]?.state).toBe('launched')
    expect(view.items[0]?.folder).toBeUndefined()
    expect(view.items[0]?.note).toBe(
      'Not filed in “OmniRogue / Prototypes”: The OmniConsole window is not open'
    )
  })

  it("raises to the preparer's high effort when the person named none, on the source agent", async () => {
    const used = host()
    const view = await run([planned()], used, 'high')
    expect(used.worktrees[0]).toMatchObject({ agent: 'claude', launch: { effort: 'high' } })
    expect(used.filed).toEqual([])
    expect(view.items[0]).toMatchObject({ agent: 'claude', effort: 'high' })
    expect(view.items[0]?.model).toBeUndefined()
  })

  it("keeps the agent's own default when the preparer would lower it", async () => {
    const used = host()
    const view = await run([planned()], used, 'medium')
    expect(used.worktrees[0]?.launch).toBeUndefined()
    expect(view.items[0]?.effort).toBeUndefined()
  })

  it('holds a disabled explicit agent choice without launching a substitute', async () => {
    const used = host({ isAgentEnabled: (agent) => agent === 'claude' })
    const view = await run([planned({ direct: true, choices: { agent: 'codex' } })], used)
    // An explicit override remains binding even when its provider is disabled.
    expect(used.worktrees).toHaveLength(0)
    expect(used.sessions).toHaveLength(0)
    expect(used.filed).toHaveLength(0)
    expect(view.items[0]).toMatchObject({ state: 'failed', agent: 'codex' })
    expect(view.items[0]?.note).toContain(
      'codex is turned off in Settings; the explicit choice was preserved'
    )
  })

  it('shows the chosen agent, effort and folder while a big batch waits', async () => {
    const used = host()
    const items = Array.from({ length: SESSION_PREP_BIG_BATCH + 1 }, (_, index) =>
      planned({ title: `Prototype ${index}`, choices: CHOSEN })
    )
    const view = await run(items, used, undefined, ['awaiting-confirm'])
    expect(view.items[0]).toMatchObject({
      agent: 'codex',
      effort: 'high',
      folder: 'OmniRogue / Prototypes'
    })
    expect(used.worktrees).toHaveLength(0)
  })
})

describe('session prep batch folders', () => {
  const unnamed = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      planned({ title: `Prototype ${index}`, changesCode: false })
    )

  it('gives a single launch no folder', async () => {
    const used = host()
    const view = await run(unnamed(1), used)
    expect(view.items[0]?.state).toBe('launched')
    expect(used.batchFolders).toEqual([])
    expect(used.filed).toEqual([])
    expect(view.items[0]?.folder).toBeUndefined()
  })

  it('files four launches from one request into one folder named from the request', async () => {
    const used = host()
    const view = await run(unnamed(4), used)
    expect(view.items.map((item) => item.state)).toEqual([
      'launched',
      'launched',
      'launched',
      'launched'
    ])
    expect(used.batchFolders).toHaveLength(1)
    const name = used.batchFolders[0]!.name(1)
    expect(name).toMatch(/^Launch · \d{2}:\d{2} · Launch sessions for prototype A and B/)
    expect(name.length).toBeLessThanOrEqual(60)
    expect(used.batchFolders[0]!.origin).toMatchObject({
      batchId: view.id,
      source: 'session-prep',
      requestExcerpt: expect.stringContaining('launch sessions for prototype A and B')
    })
    expect(used.filed).toHaveLength(4)
    expect(used.filed.map((call) => call.folder)).toEqual(
      Array.from({ length: 4 }, () => ({ id: 'batch-folder-1', path: name }))
    )
    expect(used.filed.map((call) => call.origin).toSorted((a, b) => index(a) - index(b))).toEqual(
      [0, 1, 2, 3].map((position) => ({ batchId: view.id, index: position }))
    )
    expect(view.items.every((item) => item.folder === name && !item.note)).toBe(true)
  })

  it('files an item whose folder the person named there, and the rest in the batch folder', async () => {
    const used = host()
    const view = await run(
      [...unnamed(2), planned({ title: 'Named', changesCode: false, choices: CHOSEN })],
      used
    )
    expect(used.batchFolders).toHaveLength(1)
    const named = used.filed.filter((call) => call.folder === 'OmniRogue / Prototypes')
    expect(named).toHaveLength(1)
    expect(named[0]?.origin).toBeUndefined()
    expect(used.filed.filter((call) => typeof call.folder === 'object')).toHaveLength(2)
    expect(view.items[2]?.folder).toBe('Saved Sessions / OmniRogue / Prototypes')
  })

  it('still launches every item when the folder cannot be made, and says so', async () => {
    const used = host({
      createBatchFolder: async () => {
        throw new Error('The OmniConsole window is not open')
      }
    })
    const view = await run(unnamed(2), used)
    expect(view.items.map((item) => item.state)).toEqual(['launched', 'launched'])
    expect(used.filed).toEqual([])
    expect(view.items.map((item) => item.note)).toEqual(
      Array(2).fill('Not filed in a batch folder: The OmniConsole window is not open')
    )
  })
})

function index(origin: unknown): number {
  return (origin as { index: number }).index
}
