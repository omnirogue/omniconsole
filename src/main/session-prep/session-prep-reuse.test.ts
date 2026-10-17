import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type {
  GateVerdict,
  SessionPrepBatchView,
  SessionPrepSteps
} from '../../shared/session-prep-types'
import type { SessionPrepHost } from './session-prep-host'
import type { SessionPrepReuse } from './session-prep-reuse'
import { reconcileSessionPrepReuseReservation, reserveSessionPrepReuse } from './session-prep-reuse'
import type { SessionPrepBatchRecord } from './session-prep-records'
import { applySessionPrepReuseChoice } from './session-prep-reuse-choice'
import { SessionPrepService } from './session-prep-service'
import { SessionPrepStore } from './session-prep-store'

const SOURCE = { worktreeId: 'repo-1::/src', paneKey: 'pane-1', agent: 'claude' as const }
const PASS: GateVerdict = {
  pass: true,
  failures: [],
  ask: null,
  scores: {},
  judge: 'deterministic'
}
const OFFER = {
  kind: 'assign' as const,
  paneKey: 'tab-7:leaf-1',
  tabId: 'tab-7',
  title: 'Parser work',
  why: 'idle, same folder'
}

const steps: SessionPrepSteps = {
  plan: async () => ({
    items: [
      {
        title: 'Parser retries',
        ask: 'add retries to the parser',
        anchor: 'add retries',
        direct: false,
        changesCode: false
      }
    ],
    dropped: []
  }),
  prepare: async ({ item }) => ({
    title: item.title,
    outcome: item.ask,
    doneWhen: ['tests pass'],
    decided: [],
    references: [],
    constraints: [],
    assumptions: [],
    blockingQuestion: null,
    changesCode: false
  }),
  revise: async ({ fields }) => fields,
  gate: async () => PASS,
  render: ({ fields }) => `RENDER:${fields.outcome}`,
  renderDirect: ({ item }) => `DIRECT:${item.ask}`
}

function host(): SessionPrepHost & { sessions: unknown[] } {
  const sessions: unknown[] = []
  const repo = {
    selector: 'id:repo-1',
    name: 'App',
    id: 'repo-1',
    path: '/src',
    isFolder: false,
    isRemote: false
  }
  return {
    sessions,
    resolveWorktree: async () => ({
      path: '/src',
      repoId: 'repo-1',
      isFolder: false,
      isRemote: false
    }),
    listRepos: () => [repo],
    resolveRepo: (selector) => (selector === 'id:repo-1' ? repo : null),
    createWorktreeWithAgent: async () => ({ worktreeId: 'repo-1::/wt' }),
    createAgentSessionIn: async (args) => {
      sessions.push(args)
      return { tabId: `new-tab-${sessions.length}`, paneKey: `new-pane-${sessions.length}` }
    },
    worktreeExistsByName: async () => false,
    findWorktreeIdByName: async () => null,
    isAgentEnabled: () => true,
    fileSession: async () => ({ path: 'Launch' }),
    createBatchFolder: async () => ({ id: 'batch-folder', path: 'Launch' })
  }
}

async function start(reuse: SessionPrepReuse, projectAgentId?: string, prepSteps = steps) {
  const used = host()
  if (projectAgentId) {
    used.resolveExistingFolder = async () => ({ id: 'project', path: 'Project' })
    used.projectLaunch = async ({ templateId }) => ({
      project: { folderId: 'project', name: 'Project' },
      projectLine: 'Project: Project',
      host: { id: 'local', label: 'Home' },
      attachments: [],
      inherited: [],
      notOnHost: [],
      error: null,
      agent: {
        templateId: templateId ?? 'default-project-agent',
        name: 'Project copy',
        digest: 'a'.repeat(12),
        instructions: templateId === projectAgentId ? 'PROJECT COPY INSTRUCTIONS' : 'WRONG DEFAULT'
      }
    })
  }
  const store = new SessionPrepStore(await mkdtemp(join(tmpdir(), 'session-prep-reuse-')))
  const instance = new SessionPrepService({
    host: used,
    steps: () => prepSteps,
    store,
    now: () => 1_700_000_000_000,
    reuse
  })
  await instance.start()
  const { batchId } = instance.request({
    text: 'add retries to the parser',
    source: SOURCE,
    context: '',
    ...(projectAgentId ? { agentTemplateId: projectAgentId, defaultFolder: 'project' } : {})
  })
  return { instance, host: used, batchId, store }
}

async function until(
  instance: SessionPrepService,
  batchId: string,
  done: (view: SessionPrepBatchView) => boolean
): Promise<SessionPrepBatchView> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    const view = instance.get(batchId)
    if (done(view)) {
      return view
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`batch still ${JSON.stringify(instance.get(batchId))}`)
}

const offering = (
  over: Partial<SessionPrepReuse> = {}
): SessionPrepReuse & {
  find: ReturnType<typeof vi.fn>
  assign: ReturnType<typeof vi.fn>
} =>
  ({
    find: vi.fn(async () => ({ offer: OFFER })),
    assign: vi.fn(async () => {}),
    ...over
  }) as never

describe('session prep reuse before launching', () => {
  it.each([
    ['reviewer', 'assign'],
    ['project-only', 'assign'],
    ['reviewer', 'launch'],
    ['project-only', 'launch']
  ] as const)(
    'keeps %s project instructions once when choosing %s after restart',
    async (id, choice) => {
      const reuse = offering()
      const { instance, host: used, batchId, store } = await start(reuse, id)
      await until(instance, batchId, (v) => v.items[0]?.state === 'awaiting-reuse')
      await store.persist()
      const restored = new SessionPrepService({
        host: used,
        steps: () => steps,
        store: new SessionPrepStore(store.directory),
        reuse
      })
      await restored.start()
      await restored.decideReuse(batchId, 0, choice)
      const view = await until(restored, batchId, (v) => v.state === 'done')
      expect(view.items[0]?.state).toBe(choice === 'assign' ? 'assigned' : 'launched')
      const prompt =
        choice === 'assign'
          ? reuse.assign.mock.calls[0]?.[0].prompt
          : (used.sessions[0] as { prompt: string }).prompt
      expect(prompt.split('PROJECT COPY INSTRUCTIONS')).toHaveLength(2)
      expect(prompt.split('Project: Project')).toHaveLength(2)
      expect(prompt).not.toContain('# Reviewer')
      expect(prompt).not.toContain('WRONG DEFAULT')
      expect(used.sessions).toHaveLength(choice === 'assign' ? 0 : 1)
      expect(reuse.assign).toHaveBeenCalledTimes(choice === 'assign' ? 1 : 0)
    }
  )

  it('holds the item with the offered session instead of launching', async () => {
    const reuse = offering()
    const { instance, host: used, batchId } = await start(reuse)
    const view = await until(instance, batchId, (v) => v.items[0]?.state === 'awaiting-reuse')
    expect(view.items[0]!.reuse).toEqual({
      kind: 'assign',
      title: 'Parser work',
      why: 'idle, same folder'
    })
    expect(used.sessions).toHaveLength(0)
    expect(reuse.find).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePaneKey: 'pane-1',
        task: 'Parser retries: add retries to the parser',
        prompt: 'RENDER:add retries to the parser',
        files: [],
        scope: { repoId: 'repo-1', worktreeId: 'repo-1::/src', targetWorktreeId: 'repo-1::/src' },
        exclude: new Set(['pane-1'])
      })
    )
  })

  it('serializes sibling lookups until the first item has durable owner evidence', async () => {
    const twoItems: SessionPrepSteps = {
      ...steps,
      plan: async () => ({
        items: [
          {
            title: 'Parser retries',
            ask: 'add retries',
            anchor: 'add retries',
            direct: false,
            changesCode: false
          },
          {
            title: 'Parser tests',
            ask: 'add parser tests',
            anchor: 'add parser tests',
            direct: false,
            changesCode: false
          }
        ],
        dropped: []
      })
    }
    let finishFirst!: (value: { offer: typeof OFFER }) => void
    const firstLookup = new Promise<{ offer: typeof OFFER }>((resolve) => {
      finishFirst = resolve
    })
    const reuse = offering({
      find: vi
        .fn()
        .mockImplementationOnce(() => firstLookup)
        .mockResolvedValue({ note: 'none' })
    })
    const { instance, host: used, batchId, store } = await start(reuse, undefined, twoItems)
    await until(instance, batchId, (view) =>
      view.items.every((item) => item.state === 'preparing' || item.state === 'awaiting-reuse')
    )
    // Let both items finish preparing; the first now holds the persisted lookup reservation.
    await until(instance, batchId, () => reuse.find.mock.calls.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(reuse.find).toHaveBeenCalledTimes(1)
    expect(used.sessions).toHaveLength(0)
    finishFirst({ offer: OFFER })
    await until(instance, batchId, (view) => view.items.some((item) => item.state === 'launched'))
    expect(reuse.find).toHaveBeenCalledTimes(2)
    expect(reuse.find.mock.calls[1]?.[0].exclude).toEqual(new Set(['pane-1', OFFER.paneKey]))
    expect(used.sessions).toHaveLength(1)
    await instance.decideReuse(batchId, 0, 'assign')
    await until(instance, batchId, (view) => view.state === 'done')
    expect(store.get(batchId)?.items[1]?.launched).toMatchObject({ paneKey: 'new-pane-1' })
  })

  it('reconciles a failed reservation write so a later lookup can proceed', async () => {
    const batch = { id: 'failed-reservation' } as SessionPrepBatchRecord
    const persist = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValue(undefined)
    await expect(reserveSessionPrepReuse(batch, 0, 1, persist, () => false)).rejects.toThrow(
      'disk full'
    )
    expect(batch.reuseReservation).toMatchObject({ index: 0, startedAt: 1 })
    await reconcileSessionPrepReuseReservation(batch, persist)
    expect(batch.reuseReservation).toBeUndefined()
    const release = await reserveSessionPrepReuse(batch, 1, 2, persist, () => false)
    expect(batch.reuseReservation).toMatchObject({ index: 1, startedAt: 2 })
    await release?.()
    expect(batch.reuseReservation).toBeUndefined()
  })

  it('wakes waiters on a failed release write and keeps the ambiguous reservation fail-closed', async () => {
    const batch = { id: 'release-failure' } as SessionPrepBatchRecord
    let writes = 0
    const persist = vi.fn(async () => {
      writes += 1
      if (writes === 2) {
        throw new Error('write outcome unknown')
      }
    })
    const release = await reserveSessionPrepReuse(batch, 0, 1, persist, () => false)
    const waiting = reserveSessionPrepReuse(batch, 1, 2, persist, () => false)
    await expect(release?.()).rejects.toThrow('write outcome unknown')
    expect(batch.reuseReservation).toMatchObject({ index: 0, startedAt: 1 })
    await expect(waiting).resolves.toBeNull()
    await reconcileSessionPrepReuseReservation(batch, persist)
    expect(batch.reuseReservation).toBeUndefined()
    const resumed = await reserveSessionPrepReuse(batch, 1, 3, persist, () => false)
    expect(resumed).toBeTypeOf('function')
    await resumed?.()
  })

  it('releases replaced reservation owners without clearing the newer marker', async () => {
    const batch = { id: 'reservation-replaced' } as SessionPrepBatchRecord
    const persist = vi.fn(async () => {})
    const release = await reserveSessionPrepReuse(batch, 0, 1, persist, () => false)
    const waiting = reserveSessionPrepReuse(batch, 1, 2, persist, () => false)
    batch.reuseReservation = { index: 2, startedAt: 3, token: 'new-owner' }
    await release?.()
    await expect(waiting).resolves.toBeNull()
    expect(batch.reuseReservation).toEqual({ index: 2, startedAt: 3, token: 'new-owner' })
    await reconcileSessionPrepReuseReservation(batch, persist)
    expect(batch.reuseReservation).toBeUndefined()
  })

  it('does not launch a cancelled sibling after a pending reuse lookup releases', async () => {
    const twoItems: SessionPrepSteps = {
      ...steps,
      plan: async () => ({
        items: [
          {
            title: 'Parser retries',
            ask: 'add retries',
            anchor: 'add retries',
            direct: false,
            changesCode: false
          },
          {
            title: 'Parser tests',
            ask: 'add parser tests',
            anchor: 'add parser tests',
            direct: false,
            changesCode: false
          }
        ],
        dropped: []
      })
    }
    let finishFirst!: (value: { note: string }) => void
    const firstLookup = new Promise<{ note: string }>((resolve) => {
      finishFirst = resolve
    })
    const reuse = offering({
      find: vi
        .fn()
        .mockImplementationOnce(() => firstLookup)
        .mockResolvedValue({ note: 'none' })
    })
    const { instance, host: used, batchId } = await start(reuse, undefined, twoItems)
    await until(instance, batchId, () => reuse.find.mock.calls.length === 1)
    await instance.cancel(batchId)
    finishFirst({ note: 'none' })
    const view = await until(instance, batchId, (value) => value.state === 'cancelled')
    expect(view.items.every((item) => item.state === 'cancelled')).toBe(true)
    expect(reuse.find).toHaveBeenCalledTimes(1)
    expect(used.sessions).toHaveLength(0)
  })

  it('clears a stale lookup reservation on restart and keeps launched panes excluded', async () => {
    const twoItems: SessionPrepSteps = {
      ...steps,
      plan: async () => ({
        items: [
          {
            title: 'Parser retries',
            ask: 'add retries',
            anchor: 'add retries',
            direct: false,
            changesCode: false
          },
          {
            title: 'Parser tests',
            ask: 'add parser tests',
            anchor: 'add parser tests',
            direct: false,
            changesCode: false
          }
        ],
        dropped: []
      })
    }
    const {
      instance,
      host: used,
      batchId,
      store
    } = await start(offering({ find: vi.fn(async () => ({ note: 'none' })) }), undefined, twoItems)
    await until(instance, batchId, (view) => view.state === 'done')
    const batch = store.get(batchId)!
    const priorPane = batch.items[0]!.launched!.paneKey!
    batch.state = 'running'
    batch.items[1]!.state = 'planned'
    delete batch.items[1]!.launched
    delete batch.items[1]!.launch
    batch.reuseReservation = { index: 1, startedAt: 1, token: 'stale-owner' }
    await store.persist()
    const find = vi.fn(async () => ({ note: 'none' }))
    const restoredStore = new SessionPrepStore(store.directory)
    const restored = new SessionPrepService({
      host: used,
      steps: () => twoItems,
      store: restoredStore,
      reuse: offering({ find })
    })
    await restored.start()
    await until(restored, batchId, (view) => view.state === 'done')
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({ exclude: new Set(['pane-1', priorPane]) })
    )
    expect(restoredStore.get(batchId)?.reuseReservation).toBeUndefined()
  })

  it('reconciles a saved Launch new choice before restarting its launch', async () => {
    const reuse = offering()
    const { instance, host: used, batchId, store } = await start(reuse)
    await until(instance, batchId, (view) => view.items[0]?.state === 'awaiting-reuse')
    const batch = store.get(batchId)!
    batch.items[0]!.reuse!.decided = 'launch'
    batch.reuseReservation = { index: 0, startedAt: 1, token: 'crashed-launch' }
    await store.persist()

    const restoredStore = new SessionPrepStore(store.directory)
    const restored = new SessionPrepService({
      host: used,
      steps: () => steps,
      store: restoredStore,
      reuse
    })
    await restored.start()
    const view = await until(restored, batchId, (value) => value.state === 'done')
    expect(view.items[0]?.state).toBe('launched')
    expect(restoredStore.get(batchId)?.reuseReservation).toBeUndefined()
    expect(used.sessions).toHaveLength(1)
  })

  it('reconciles before relaunching a saved worktree choice when the worktree is absent', async () => {
    const worktreeSteps: SessionPrepSteps = {
      ...steps,
      plan: async () => ({
        items: [
          {
            title: 'Parser retries',
            ask: 'add retries',
            anchor: 'add retries',
            direct: false,
            changesCode: true
          }
        ],
        dropped: []
      }),
      prepare: async ({ item }) => ({
        title: item.title,
        outcome: item.ask,
        doneWhen: ['tests pass'],
        decided: [],
        references: [],
        constraints: [],
        assumptions: [],
        blockingQuestion: null,
        changesCode: true
      })
    }
    const reuse = offering()
    const { instance, host: used, batchId, store } = await start(reuse, undefined, worktreeSteps)
    await until(instance, batchId, (view) => view.items[0]?.state === 'awaiting-reuse')
    const batch = store.get(batchId)!
    batch.items[0]!.reuse!.decided = 'launch'
    batch.items[0]!.state = 'launching'
    batch.items[0]!.launch = { kind: 'worktree', name: 'parser-retries', startedAt: 1 }
    batch.reuseReservation = { index: 0, startedAt: 1, token: 'crashed-worktree' }
    await store.persist()

    const restoredStore = new SessionPrepStore(store.directory)
    const restored = new SessionPrepService({
      host: used,
      steps: () => worktreeSteps,
      store: restoredStore,
      reuse
    })
    await restored.start()
    const view = await until(restored, batchId, (value) => value.state === 'done')
    expect(view.items[0]?.state).toBe('launched')
    expect(restoredStore.get(batchId)?.reuseReservation).toBeUndefined()
    expect(used.sessions).toHaveLength(0)
    expect(view.items[0]?.launched).toMatchObject({ worktreeId: 'repo-1::/wt' })
  })

  it('holds sibling reuse after restart when the created worktree has no exact pane identity', async () => {
    const twoCodeItems: SessionPrepSteps = {
      ...steps,
      plan: async () => ({
        items: [
          {
            title: 'Parser retries',
            ask: 'add retries',
            anchor: 'add retries',
            direct: false,
            changesCode: true
          },
          {
            title: 'Parser tests',
            ask: 'add parser tests',
            anchor: 'add tests',
            direct: false,
            changesCode: true
          }
        ],
        dropped: []
      }),
      prepare: async ({ item }) => ({
        title: item.title,
        outcome: item.ask,
        doneWhen: ['tests pass'],
        decided: [],
        references: [],
        constraints: [],
        assumptions: [],
        blockingQuestion: null,
        changesCode: true
      })
    }
    const reuse = offering()
    const used = host()
    used.worktreeExistsByName = async () => true
    used.findWorktreeIdByName = async () => 'repo-1::/recovered'
    const store = new SessionPrepStore(
      await mkdtemp(join(tmpdir(), 'session-prep-recovered-worktree-'))
    )
    const batchId = 'sp_1700000000abcdef'
    store.upsert({
      id: batchId,
      createdAt: 1,
      updatedAt: 1,
      state: 'running',
      source: SOURCE,
      request: 'add retries and tests',
      context: '',
      dropped: [],
      items: [
        {
          index: 0,
          planned: {
            title: 'Parser retries',
            ask: 'add retries',
            anchor: 'add retries',
            direct: false,
            changesCode: true
          },
          state: 'launching',
          verdicts: [],
          repairs: 0,
          prompt: 'Launch parser retries',
          launch: { kind: 'worktree', name: 'parser-retries', startedAt: 1 },
          reuse: { ...OFFER, decided: 'launch' }
        },
        {
          index: 1,
          planned: {
            title: 'Parser tests',
            ask: 'add tests',
            anchor: 'add tests',
            direct: false,
            changesCode: true
          },
          state: 'planned',
          verdicts: [],
          repairs: 0
        }
      ],
      reuseReservation: { index: 0, startedAt: 1, token: 'created-without-receipt' }
    })
    await store.persist()
    const restored = new SessionPrepService({
      host: used,
      steps: () => twoCodeItems,
      store,
      reuse
    })
    await restored.start()
    const view = await until(restored, batchId, (value) => value.state === 'done')
    expect(store.get(batchId)?.items[0]?.launched).toEqual({
      worktreeId: 'repo-1::/recovered',
      newWorkspace: true,
      at: expect.any(Number),
      paneIdentity: 'unresolved-recovered'
    })
    expect(view.items[1]).toMatchObject({
      state: 'failed',
      note: expect.stringContaining('pane identity is unavailable')
    })
    expect(reuse.find).not.toHaveBeenCalled()
    expect(used.sessions).toHaveLength(0)
  })

  it('gives the prepared prompt to that session when the person confirms it', async () => {
    const reuse = offering()
    const { instance, host: used, batchId } = await start(reuse)
    await until(instance, batchId, (v) => v.items[0]?.state === 'awaiting-reuse')
    await instance.decideReuse(batchId, 0, 'assign')
    const view = await until(instance, batchId, (v) => v.state === 'done')
    expect(view.items[0]!.state).toBe('assigned')
    expect(reuse.assign).toHaveBeenCalledWith({
      sourcePaneKey: 'pane-1',
      owner: { paneKey: 'tab-7:leaf-1', tabId: 'tab-7' },
      prompt: 'RENDER:add retries to the parser',
      request: 'add retries to the parser',
      reason: 'session prep: given to an existing session (idle, same folder) instead of launching'
    })
    expect(used.sessions).toHaveLength(0)
  })

  it('records assign before an interrupted delivery can be offered again', async () => {
    let releaseDelivery!: () => void
    const delivery = new Promise<void>((resolve) => {
      releaseDelivery = resolve
    })
    const reuse = offering({ assign: vi.fn(async () => delivery) })
    const { instance, host: used, batchId, store } = await start(reuse)
    await until(instance, batchId, (view) => view.items[0]?.state === 'awaiting-reuse')

    const deciding = instance.decideReuse(batchId, 0, 'assign')
    await vi.waitFor(() => expect(reuse.assign).toHaveBeenCalledOnce(), { timeout: 2_000 })
    const persisted = JSON.parse(await readFile(join(store.directory, 'batches.json'), 'utf8'))
    expect(persisted.batches[0].items[0].reuse.decided).toBe('assign')

    const restored = new SessionPrepService({
      host: used,
      steps: () => steps,
      store: new SessionPrepStore(store.directory),
      reuse
    })
    await restored.start()
    expect(restored.get(batchId).items[0]).toMatchObject({
      state: 'failed',
      note: expect.stringContaining('Interrupted while giving it')
    })
    expect(reuse.assign).toHaveBeenCalledOnce()

    releaseDelivery()
    await deciding
  })

  it('allows cancellation during the hold before an idle session receives the prompt', async () => {
    const reuse = offering()
    const { instance, batchId } = await start(reuse)
    await until(instance, batchId, (view) => view.items[0]?.state === 'awaiting-reuse')
    const deciding = instance.decideReuse(batchId, 0, 'assign')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(reuse.assign).not.toHaveBeenCalled()
    await instance.cancel(batchId)
    await deciding
    expect(reuse.assign).not.toHaveBeenCalled()
    expect(instance.get(batchId).items[0]?.state).toBe('cancelled')
  })

  it('does not deliver after cancellation wins during the durable assign decision', async () => {
    let releasePersist!: () => void
    const persisted = new Promise<void>((resolve) => {
      releasePersist = resolve
    })
    const reuse = offering()
    const { instance, batchId, store } = await start(reuse)
    await until(instance, batchId, (view) => view.items[0]?.state === 'awaiting-reuse')
    const batch = store.get(batchId)!
    const deciding = applySessionPrepReuseChoice(
      {
        persist: vi.fn(async () => persisted),
        isCancelled: (id, index) => instance.get(id).items[index]?.state === 'cancelled',
        reuse
      } as never,
      batch,
      0,
      'assign',
      vi.fn()
    )
    await vi.waitFor(() => expect(batch.items[0]!.reuse?.decided).toBe('assign'))
    await instance.cancel(batchId)
    releasePersist()
    await deciding

    expect(instance.get(batchId)).toMatchObject({
      state: 'cancelled',
      items: [{ state: 'cancelled' }]
    })
    expect(batch.items[0]!.reuse?.decided).toBe('assign')
    expect(reuse.assign).not.toHaveBeenCalled()
  })

  it('launches new, exactly once, when the person switches to Launch new', async () => {
    const reuse = offering()
    const { instance, host: used, batchId } = await start(reuse)
    await until(instance, batchId, (v) => v.items[0]?.state === 'awaiting-reuse')
    await instance.decideReuse(batchId, 0, 'launch')
    const view = await until(instance, batchId, (v) => v.state === 'done')
    expect(view.items[0]!.state).toBe('launched')
    expect(used.sessions).toEqual([
      expect.objectContaining({
        worktreeId: 'repo-1::/src',
        prompt: 'RENDER:add retries to the parser'
      })
    ])
    expect(reuse.find).toHaveBeenCalledTimes(1)
    expect(reuse.assign).not.toHaveBeenCalled()
    await expect(instance.decideReuse(batchId, 0, 'assign')).rejects.toThrow('not waiting')
  })

  it('keeps the choice open, with the reason, when the session got busy before Confirm', async () => {
    const reuse = offering({
      assign: vi.fn(async () => {
        throw new Error('“Parser work” is no longer free (working), so nothing was sent')
      })
    })
    const { instance, host: used, batchId } = await start(reuse)
    await until(instance, batchId, (v) => v.items[0]?.state === 'awaiting-reuse')
    const view = await instance.decideReuse(batchId, 0, 'assign')
    expect(view.items[0]).toMatchObject({
      state: 'awaiting-reuse',
      reuse: { failed: '“Parser work” is no longer free (working), so nothing was sent' }
    })
    expect(used.sessions).toHaveLength(0)
  })

  it('launches as before, with the note, when no session is offered', async () => {
    const reuse = offering({
      find: vi.fn(async () => ({ note: '“Parser work” does related work but is busy (working)' }))
    })
    const { instance, host: used, batchId } = await start(reuse)
    const view = await until(instance, batchId, (v) => v.state === 'done')
    expect(view.items[0]).toMatchObject({
      state: 'launched',
      note: '“Parser work” does related work but is busy (working)'
    })
    expect(used.sessions).toHaveLength(1)
  })

  it('does not launch a duplicate when the person keeps "Already being done"', async () => {
    const reuse = offering({
      find: vi.fn(async () => ({ offer: { ...OFFER, kind: 'duplicate' as const } }))
    })
    const { instance, host: used, batchId } = await start(reuse)
    await until(instance, batchId, (v) => v.items[0]?.state === 'awaiting-reuse')
    await expect(instance.decideReuse(batchId, 0, 'assign')).rejects.toThrow('not offered')
    await instance.decideReuse(batchId, 0, 'skip')
    const view = await until(instance, batchId, (v) => v.state === 'done')
    expect(view.items[0]).toMatchObject({
      state: 'already-covered',
      note: 'Not launched: already being done by “Parser work”',
      reuse: { kind: 'duplicate', title: 'Parser work' }
    })
    expect(used.sessions).toHaveLength(0)
    expect(reuse.assign).not.toHaveBeenCalled()
  })

  it('launches anyway beside a busy editor of the same files only when the person says so', async () => {
    const reuse = offering({
      find: vi.fn(async () => ({
        offer: { ...OFFER, kind: 'conflict-busy' as const, why: 'busy, editing the same files' }
      }))
    })
    const { instance, host: used, batchId } = await start(reuse)
    await until(instance, batchId, (v) => v.items[0]?.state === 'awaiting-reuse')
    expect(used.sessions).toHaveLength(0)
    await instance.decideReuse(batchId, 0, 'launch')
    const view = await until(instance, batchId, (v) => v.state === 'done')
    expect(view.items[0]!.state).toBe('launched')
    expect(used.sessions).toHaveLength(1)
  })
})
