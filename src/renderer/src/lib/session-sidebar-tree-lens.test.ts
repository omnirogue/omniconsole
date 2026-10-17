import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { AgentPaneCard, AttentionPane } from '@/components/attention/agent-pane-snapshot'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { emptySessionFolderMetadata, type SessionFolder } from './session-folders'
import {
  buildSessionFocusLines,
  SESSION_FOCUS_LINE_LIMIT,
  sessionFocusLineCount
} from './session-focus-lines'
import type { SessionSidebarLens, SessionSidebarLensContext } from './session-sidebar-lens'
import {
  computerLensBucketId,
  sessionLensGroupKey,
  UNKNOWN_COMPUTER_BUCKET_ID
} from './session-sidebar-lens'
import {
  emptySessionSidebarView,
  parseSessionSidebarView,
  sessionSidebarGroupBy,
  withSessionSidebarGroupBy,
  type SessionSidebarGroupBy,
  type SessionSidebarView
} from './session-sidebar-view'
import { buildSessionSidebarTree, type SessionSidebarTreeInput } from './session-sidebar-tree'
import { buildSidebarSessions, type SidebarSession } from './sidebar-sessions'
import type { RuntimeSessionConversationRecord } from '../../../shared/session-conversation-ledger'
import {
  ledgerBucket,
  ledgerOwner,
  ledgerRecord,
  ledgerSlices,
  pairedSource
} from './mirrored-conversation-test-fixtures'

const organizationWrites = vi.hoisted(() => ({ apply: vi.fn(), undo: vi.fn() }))
vi.mock('@/lib/session-organization-change', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  applyOrganizationChange: organizationWrites.apply,
  undoOrganizationChange: organizationWrites.undo
}))
vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => `device:${key}`,
  readPersonalView: (storage: Storage, key: string) => storage.getItem(`device:${key}`)
}))

const now = 1_000_000_000_000
const LENSES: SessionSidebarLens[] = [
  'state',
  'request',
  'project',
  'company',
  'computer',
  'blocking'
]
const folderId = (index: number) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
const HOSTS: ExecutionHostId[] = ['local', 'ssh:box-a', 'ssh:box-b', 'local']

/** OmniRogue (0) holds two projects (1, 2); 3–9 are plain folders; 10–11 are saved projects. */
const FOLDERS: SessionFolder[] = [
  { id: folderId(0), name: 'OmniRogue' },
  { id: folderId(1), name: 'Checkout', parentId: folderId(0) },
  { id: folderId(2), name: 'Ads', parentId: folderId(0) },
  ...Array.from({ length: 7 }, (_, index) => ({ id: folderId(index + 3), name: `Work ${index}` })),
  { id: folderId(10), name: 'Site relaunch', section: 'saved' as const },
  { id: folderId(11), name: 'Onboarding', section: 'saved' as const }
]

type Spec = {
  key: string
  folder?: number
  host: ExecutionHostId
  state?: 'working' | 'done' | 'idle'
  ask?: boolean
  unavailable?: boolean
  waitMinutes?: number
}

function session(spec: Spec): SidebarSession {
  return {
    rowKey: spec.key,
    sessionKey: spec.key,
    worktreeId: 'w1',
    hostId: spec.host,
    tabId: `tab-${spec.key}`,
    paneKey: `tab-${spec.key}:leaf`,
    kind: 'terminal',
    label: spec.key,
    workspaceLabel: 'Website / main',
    agent: 'codex',
    unavailable: spec.unavailable === true,
    folderKeyMigration: null
  }
}

function card(spec: Spec, dotState: AgentPaneCard['dotState']): AgentPaneCard {
  return {
    paneKey: `tab-${spec.key}:leaf`,
    worktreeId: 'w1',
    tabId: `tab-${spec.key}`,
    leafId: 'leaf',
    agentType: 'codex',
    bucket: dotState === 'working' ? 'working' : 'idle',
    dotState,
    unseen: false,
    title: spec.key,
    stateChangedAt: now - 1000,
    repoName: 'Website',
    worktreeName: 'main'
  } as AgentPaneCard
}

/** A hundred sessions: every 7th asks, every 11th is on a computer out of reach, every 3rd works. */
function sample(total = 100): Spec[] {
  return Array.from({ length: total }, (_, index): Spec => {
    const spec: Spec = {
      key: `s${index}`,
      folder: index % 13 === 12 ? undefined : index % 12,
      host: HOSTS[index % HOSTS.length]!
    }
    if (index % 7 === 0) {
      return { ...spec, ask: true }
    }
    if (index % 11 === 0) {
      return { ...spec, state: 'done', unavailable: true }
    }
    if (index % 17 === 0) {
      return { ...spec, waitMinutes: 20 }
    }
    return { ...spec, state: index % 3 === 0 ? 'working' : index % 2 ? 'done' : 'idle' }
  })
}

function lensContext(): SessionSidebarLensContext {
  const folders: NonNullable<SessionSidebarLensContext['origins']>['folders'] = {}
  const sessions: NonNullable<SessionSidebarLensContext['origins']>['sessions'] = {}
  for (let batch = 0; batch < 8; batch += 1) {
    const folder = folderId(3 + (batch % 7))
    folders[folder] ??= {
      folderId: folder,
      batchId: `batch-${batch}`,
      requestExcerpt: `Request ${batch}`,
      createdAt: now - batch * 60_000,
      source: 'session-prep'
    }
    for (let item = 0; item < 5; item += 1) {
      sessions[`s${batch * 5 + item}`] = { batchId: `batch-${batch}`, index: item, at: now }
    }
  }
  return {
    origins: { folders, sessions },
    hosts: new Map([
      ['ssh:box-a', { label: 'Box A', reachable: true }],
      ['ssh:box-b', { label: 'Box B', reachable: false }]
    ]),
    companyOf: (row) =>
      Number(row.rowKey.slice(1)) % 5 === 0 ? { id: 'betacorp', label: 'BetaCorp' } : null
  }
}

function treeInput(specs: Spec[], groupBy?: SessionSidebarGroupBy): SessionSidebarTreeInput {
  const working = specs.filter((spec) => spec.state && spec.state !== 'idle' && !spec.ask)
  const asking = specs.filter((spec) => spec.ask)
  return {
    now,
    sessions: specs.map(session),
    metadata: {
      ...emptySessionFolderMetadata(),
      folders: FOLDERS,
      membership: Object.fromEntries(
        specs.flatMap((spec) =>
          spec.folder === undefined ? [] : [[spec.key, folderId(spec.folder)]]
        )
      )
    },
    view: groupBy
      ? withSessionSidebarGroupBy(emptySessionSidebarView(), groupBy)
      : emptySessionSidebarView(),
    snapshot: {
      cardsByPaneKey: new Map(
        working.map((spec) => [
          `tab-${spec.key}:leaf`,
          card(spec, spec.state as AgentPaneCard['dotState'])
        ])
      ),
      cardsByTabId: new Map(),
      attentionByPaneKey: new Map<string, AttentionPane>(
        asking.map((spec) => [
          `tab-${spec.key}:leaf`,
          {
            ...card(spec, 'waiting'),
            bucket: 'attention',
            cause: 'waiting',
            portalPaneKey: `tab-${spec.key}:leaf`
          } as AttentionPane
        ])
      )
    },
    waitingUntilByPaneKey: new Map(
      specs.flatMap((spec) =>
        spec.waitMinutes === undefined
          ? []
          : [[`tab-${spec.key}:leaf`, new Date(now + spec.waitMinutes * 60_000).toISOString()]]
      )
    ),
    query: '',
    showHidden: false,
    showArchived: false,
    lensContext: lensContext()
  }
}

const rowKeysOf = (rows: readonly { session: { rowKey: string } }[]) =>
  rows.map((row) => row.session.rowKey).sort()

describe('Group-by views', () => {
  it.each(LENSES)('keeps the focus layout within five lines at 100 sessions: %s', (lens) => {
    const specs = sample()
    const tree = buildSessionSidebarTree(treeInput(specs, lens))
    const lines = buildSessionFocusLines(tree.groups, now)
    const asking = specs.filter((spec) => spec.ask).length
    expect(sessionFocusLineCount(lines)).toBeLessThanOrEqual(SESSION_FOCUS_LINE_LIMIT)
    // Why: Needs you stays one line holding every question, wherever the session is filed.
    expect(lines.needsYou?.rows).toHaveLength(asking)
    expect(lines.folders.length).toBeGreaterThan(0)
    expect(lines.folders.length).toBeLessThanOrEqual(3)
    for (const line of lines.folders) {
      expect(line.lens).toBe(lens)
      expect(line.key.startsWith(`by:${lens}:`)).toBe(true)
    }
    expect(lines.byLens).toBe(true)
    const shown = lines.folders.reduce((sum, line) => sum + line.tally.total, 0)
    expect(lines.everythingElse.sessions + shown + asking).toBe(specs.length)
    // Every non-asking session sits in exactly one lens group of the full tree.
    const listed = tree.groups.filter((group) => group.kind === lens).flatMap((group) => group.rows)
    expect(rowKeysOf(listed)).toEqual(
      specs
        .filter((spec) => !spec.ask)
        .map((spec) => spec.key)
        .sort()
    )
  })

  it('names the lens buckets from origins, folders, tags and hosts', () => {
    const specs = sample()
    const labels = (lens: SessionSidebarLens) =>
      buildSessionSidebarTree(treeInput(specs, lens))
        .groups.filter((group) => group.kind === lens)
        .map((group) => group.label)
    expect(labels('request').slice(0, 2)).toEqual(['Request 0', 'Request 1'])
    expect(labels('request').at(-1)).toBe('Not from a request')
    // Saved projects lead; OmniRogue is a company folder, so its children are the projects.
    expect(labels('project').slice(0, 2)).toEqual(['Site relaunch', 'Onboarding'])
    expect(labels('project')).toEqual(expect.arrayContaining(['Checkout', 'Ads', 'Work 0']))
    expect(labels('project')).not.toContain('OmniRogue')
    expect(labels('company')).toEqual(['OmniRogue', 'BetaCorp', 'No company'])
    expect(labels('computer')).toEqual(['This computer', 'Box A', "Box B · can't see"])
  })

  it("separates what can't be seen from what finished under What's blocking", () => {
    const specs: Spec[] = [
      { key: 'gone-dark', host: 'ssh:box-b', state: 'done', unavailable: true },
      { key: 'finished', host: 'local', state: 'done' },
      { key: 'busy', host: 'local', state: 'working' },
      { key: 'later', host: 'local', waitMinutes: 90 },
      { key: 'asks', host: 'local', ask: true }
    ]
    const tree = buildSessionSidebarTree(treeInput(specs, 'blocking'))
    const byKey = new Map(tree.groups.map((group) => [group.key, rowKeysOf(group.rows)]))
    expect(byKey.get(sessionLensGroupKey('blocking', 'cantSee'))).toEqual(['gone-dark'])
    expect(byKey.get(sessionLensGroupKey('blocking', 'finished'))).toEqual(['finished'])
    expect(byKey.get(sessionLensGroupKey('blocking', 'working'))).toEqual(['busy'])
    expect(byKey.get(sessionLensGroupKey('blocking', 'waitingTime'))).toEqual(['later'])
    expect(byKey.get('attention')).toEqual(['asks'])
    const lens = tree.groups.filter((group) => group.kind === 'blocking')
    expect(lens.map((group) => group.label)).toEqual([
      "Can't see",
      'Working',
      'Waiting until later',
      'Finished'
    ])
  })

  it('starts every lens group folded, and a folded one still lists a question in it', () => {
    const specs: Spec[] = [
      { key: 'a', host: 'local', state: 'working', folder: 4 },
      { key: 'b', host: 'local', state: 'done', folder: 4 }
    ]
    const tree = buildSessionSidebarTree(treeInput(specs, 'project'))
    const group = tree.groups.find((entry) => entry.kind === 'project')!
    expect(group.collapsed).toBe(true)
    expect(group.folderTally).toMatchObject({ working: 1, done: 1, total: 2 })
  })
})

describe('Status view', () => {
  const withView = (input: SessionSidebarTreeInput, view: Partial<SessionSidebarView>) => ({
    ...input,
    view: { ...input.view, ...view }
  })

  it('files each session by what it is doing, wherever it is filed, with its folder kept', () => {
    const specs: Spec[] = [
      { key: 'saved-busy', host: 'local', state: 'working', folder: 10 },
      { key: 'filed-done', host: 'local', state: 'done', folder: 4 },
      { key: 'loose-later', host: 'local', waitMinutes: 90 },
      { key: 'dark', host: 'ssh:box-b', state: 'done', unavailable: true },
      { key: 'asks', host: 'local', ask: true, folder: 11 }
    ]
    const tree = buildSessionSidebarTree(treeInput(specs, 'state'))
    const byKey = new Map(tree.groups.map((group) => [group.key, rowKeysOf(group.rows)]))
    expect(byKey.get('attention')).toEqual(['asks'])
    expect(byKey.get(sessionLensGroupKey('state', 'working'))).toEqual(['saved-busy'])
    expect(byKey.get(sessionLensGroupKey('state', 'done'))).toEqual(['filed-done'])
    expect(byKey.get(sessionLensGroupKey('state', 'waiting'))).toEqual(['loose-later'])
    expect(byKey.get(sessionLensGroupKey('state', 'cantSee'))).toEqual(['dark'])
    expect(tree.groups.map((group) => group.label)).toEqual([
      'Needs you',
      'Working',
      'Waiting',
      'Done',
      "Can't see"
    ])
    const working = tree.groups.find(
      (group) => group.key === sessionLensGroupKey('state', 'working')
    )
    // Why: the row keeps its Saved folder, which its folder chip shows.
    expect(working?.rows[0]?.folderId).toBe(folderId(10))
  })

  it('lists rows inside a hidden folder in the Status view only', () => {
    const specs: Spec[] = [
      { key: 'tucked', host: 'local', state: 'working', folder: 4 },
      { key: 'open', host: 'local', state: 'working', folder: 5 }
    ]
    const hidden = { hidden: [`folder:${folderId(4)}`] }
    const listed = (lens: SessionSidebarLens) =>
      rowKeysOf(
        buildSessionSidebarTree(withView(treeInput(specs, lens), hidden)).groups.flatMap(
          (group) => group.rows
        )
      )
    expect(listed('state')).toEqual(['open', 'tucked'])
    expect(listed('computer')).toEqual(['open'])
    expect(listed('project')).toEqual(['open'])
  })

  it('groups dispatched workflow rows on their worker computer while retaining controller routing', () => {
    const input = treeInput([{ key: 'discover', host: 'local', state: 'working' }], 'computer')
    input.sessions = input.sessions.map((row) => ({ ...row, displayHostId: 'ssh:box-a' }))
    const tree = buildSessionSidebarTree(input)
    const group = tree.groups.find((group) =>
      group.rows.some((row) => row.session.rowKey === 'discover')
    )
    expect(group?.label).toBe('Box A')
    expect(group?.rows[0]?.session.hostId).toBe('local')
  })

  it('lists a row with no known host under Unknown computer, never This computer', () => {
    const input = treeInput(
      [
        { key: 'here', host: 'local', state: 'working' },
        { key: 'lost', host: 'local', state: 'working' },
        { key: 'box', host: 'ssh:box-a', state: 'working' }
      ],
      'computer'
    )
    input.sessions = input.sessions.map((row) =>
      row.rowKey === 'lost' ? { ...row, hostId: null } : row
    )
    const groups = buildSessionSidebarTree(input).groups.filter(
      (group) => group.kind === 'computer'
    )
    expect(groups.map((group) => group.label)).toEqual([
      'This computer',
      'Box A',
      'Unknown computer'
    ])
    const unknown = groups.find((group) => group.key === sessionLensGroupKey('computer', 'unknown'))
    expect(rowKeysOf(unknown?.rows ?? [])).toEqual(['lost'])
    expect(computerLensBucketId(unknown!)).toBe(UNKNOWN_COMPUTER_BUCKET_ID)
    expect(computerLensBucketId(groups[1]!)).toBe('ssh:box-a')
  })

  it('orders rows inside every group by the chosen sort', () => {
    const specs: Spec[] = [
      { key: 'b-remote', host: 'ssh:box-a', state: 'working' },
      { key: 'c-local', host: 'local', state: 'working' },
      { key: 'a-remote', host: 'ssh:box-b', state: 'working' }
    ]
    const order = (view: Partial<SessionSidebarView>) =>
      buildSessionSidebarTree(withView(treeInput(specs, 'state'), view))
        .groups.find((group) => group.key === sessionLensGroupKey('state', 'working'))!
        .rows.map((row) => row.session.rowKey)
    expect(order({ sort: 'name' })).toEqual(['a-remote', 'b-remote', 'c-local'])
    // Why: this computer first, then hosts by name (Box A, Box B).
    expect(order({ sort: 'host' })).toEqual(['c-local', 'b-remote', 'a-remote'])
    const dragged = { rowOrder: ['c-local', 'a-remote'] }
    expect(order({ ...dragged, sort: 'manual' }).slice(0, 2)).toEqual(['c-local', 'a-remote'])
    // Why: a dragged order with no sort chosen keeps showing, as before sorting existed.
    expect(order(dragged).slice(0, 2)).toEqual(['c-local', 'a-remote'])
    expect(order({ ...dragged, sort: 'status' })).not.toEqual(order({ ...dragged, sort: 'manual' }))
  })
})

describe('switching Group-by views', () => {
  it('changes no folder membership and writes no organization record', async () => {
    const { createSessionSidebarViewStore } = await import('@/store/session-sidebar-view')
    const saved: unknown[] = []
    const store = createSessionSidebarViewStore(
      {
        load: () => emptySessionSidebarView(),
        save: (view) => {
          saved.push(view)
        }
      },
      { load: () => [], save: vi.fn() }
    )
    store.getState().load()
    const { groupBy: _unset, lens: _unsetLens, ...base } = store.getState().view
    const specs = sample()
    const input = treeInput(specs)
    const membership = JSON.stringify(input.metadata)
    const folderOf = () =>
      new Map(
        buildSessionSidebarTree({ ...input, view: store.getState().view })
          .groups.flatMap((group) => group.rows)
          .map((row) => [row.session.rowKey, row.folderId])
      )
    const filedIn = (key: string) => input.metadata.membership[key] ?? null
    for (const groupBy of [
      'request',
      'project',
      'company',
      'computer',
      'blocking',
      'task',
      'status'
    ] as const) {
      store.getState().setGroupBy(groupBy)
      expect(sessionSidebarGroupBy(store.getState().view)).toBe(groupBy)
      const after = folderOf()
      // Why: under a lens every session is listed, so each one's filing can be checked.
      if (groupBy !== 'task' && groupBy !== 'status') {
        expect(after.size).toBe(specs.length)
      }
      for (const [key, folder] of after) {
        expect([key, folder]).toEqual([key, filedIn(key)])
      }
    }
    expect(JSON.stringify(input.metadata)).toBe(membership)
    expect(organizationWrites.apply).not.toHaveBeenCalled()
    expect(organizationWrites.undo).not.toHaveBeenCalled()
    // Each switch saved the per-device view and nothing else about it changed.
    expect(saved).toHaveLength(7)
    for (const view of saved) {
      const { groupBy, lens: _lens, ...rest } = view as { groupBy?: string; lens?: string }
      expect(rest).toEqual(base)
      // Why: an older build rejects any groupBy beyond these two.
      expect([undefined, 'status', 'task']).toContain(groupBy)
    }
  })

  it('persists the chosen view on this device and reads it back after a restart', async () => {
    const { createSessionSidebarViewStore } = await import('@/store/session-sidebar-view')
    const { createLocalSessionSidebarViewStorage } = await import('./session-sidebar-view-storage')
    const backing = new Map<string, string>()
    const storage = {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => void backing.set(key, value)
    }
    const archived = { load: () => [], save: vi.fn() }
    const first = createSessionSidebarViewStore(
      createLocalSessionSidebarViewStorage(() => storage),
      archived
    )
    first.getState().load()
    first.getState().setGroupBy('blocking')
    expect([...backing.keys()]).toEqual(['device:omni.session-sidebar-view.v1'])
    const second = createSessionSidebarViewStore(
      createLocalSessionSidebarViewStorage(() => storage),
      archived
    )
    second.getState().load()
    expect(sessionSidebarGroupBy(second.getState().view)).toBe('blocking')
    expect(JSON.parse(backing.get('device:omni.session-sidebar-view.v1')!)).toMatchObject({
      lens: 'blocking'
    })
    second.getState().setGroupBy('task')
    expect(JSON.parse(backing.get('device:omni.session-sidebar-view.v1')!)).not.toHaveProperty(
      'lens'
    )
  })

  it('saves a shape an older build loads without error, showing its default grouping', () => {
    // The groupBy an older build accepts; its object schema drops keys it does not know.
    const olderBuild = z.object({
      version: z.literal(1),
      collapsed: z.array(z.string()),
      hidden: z.array(z.string()),
      order: z.array(z.string()),
      groupBy: z.enum(['status', 'task']).optional(),
      layout: z.enum(['focus', 'full']).optional()
    })
    for (const choice of LENSES) {
      const saved = JSON.parse(
        JSON.stringify(
          withSessionSidebarGroupBy({ ...emptySessionSidebarView(), groupBy: 'task' }, choice)
        )
      )
      const read = olderBuild.safeParse(saved)
      expect(read.success).toBe(true)
      expect(read.data?.groupBy).toBeUndefined()
      expect(sessionSidebarGroupBy(parseSessionSidebarView(saved))).toBe(choice)
    }
  })

  it('reads a Group-by an earlier build of these views saved in groupBy as the lens', () => {
    const view = parseSessionSidebarView({ ...emptySessionSidebarView(), groupBy: 'computer' })
    expect(view.groupBy).toBeUndefined()
    expect(view.lens).toBe('computer')
    expect(sessionSidebarGroupBy(view)).toBe('computer')
  })

  it('reads a Group-by this build does not know as the default, keeping the rest of the view', () => {
    const view = parseSessionSidebarView({
      ...emptySessionSidebarView(),
      layout: 'full',
      groupBy: 'someday-view'
    })
    expect(view.groupBy).toBeUndefined()
    expect(view.lens).toBeUndefined()
    expect(view.layout).toBe('full')
    expect(
      sessionSidebarGroupBy(
        parseSessionSidebarView({ ...emptySessionSidebarView(), groupBy: 'task', lens: 'later' })
      )
    ).toBe('task')
  })
})

describe('a paired owner’s conversation ledger (session parity, step 6)', () => {
  const OWNER_ONLY = folderId(20)

  function ledgerSessions(records: RuntimeSessionConversationRecord[]): SidebarSession[] {
    const source = pairedSource()
    Object.assign(
      source,
      ledgerSlices(
        [ledgerBucket(records)],
        [ledgerOwner({ folders: [{ id: OWNER_ONLY, name: 'Studio only' }] })]
      )
    )
    return buildSidebarSessions(source)
  }

  it("lists the owner's rows under its computer, and the one it archived under Archived", () => {
    const input = treeInput([], 'computer')
    input.sessions = ledgerSessions([
      ledgerRecord('s1'),
      ledgerRecord('s2', { archived: { archived: true } })
    ])
    input.lensContext = {
      ...input.lensContext,
      hosts: new Map([['runtime:env-studio', { label: 'Mac Studio', reachable: true }]])
    }
    const tree = buildSessionSidebarTree(input)
    const studio = tree.groups.find(
      (group) => group.key === sessionLensGroupKey('computer', 'runtime:env-studio')
    )
    expect(studio?.label).toBe('Mac Studio')
    expect(studio?.rows.map((row) => row.session.label)).toEqual(['Owner s1'])
    expect(tree.archivedCount).toBe(1)
  })

  it('files a row in an owner folder not received here under a read-only group (graft 2)', () => {
    const input = treeInput([])
    input.sessions = ledgerSessions([
      ledgerRecord('s1', { folderId: OWNER_ONLY }),
      ledgerRecord('s2', { folderId: folderId(3) })
    ])
    const tree = buildSessionSidebarTree(input)
    const owner = tree.groups.find((group) => group.folder?.id === OWNER_ONLY)
    expect(owner).toMatchObject({
      kind: 'folder',
      label: 'Studio only',
      readOnlyOwnerFolder: true,
      canReorder: false
    })
    expect(owner?.rows.map((row) => row.session.label)).toEqual(['Owner s1'])
    const local = tree.groups.find((group) => group.folder?.id === folderId(3))
    expect(local?.readOnlyOwnerFolder).toBeUndefined()
    expect(local?.rows.map((row) => row.session.label)).toEqual(['Owner s2'])
  })
})
